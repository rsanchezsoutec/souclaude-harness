// Hook de Claude Code del harness (managed): reglas de PR en la sesion (SHS-M39)
// y proteccion de `main` por repo (SHS-M42).
//
// Los checks de scripts/check-pr-rules.mjs corren en CI (workflows reglas-*) y,
// antes, aca: dentro de la sesion del agente, en el momento en que importan.
//
//   PreToolUse  · git push              -> (1) deniega el push que toca `main` de
//                                          cualquier repo que no sea el Vault ni
//                                          este en modo solo; (2) grupo secretos
//                                          sobre los commits que el push subiria;
//                                          si falla, deniega el push; (3) pregunta
//                                          al usuario (`ask`) si el destino o la
//                                          carpeta del push no se pueden leer
//                                          del comando (variables, xargs, alias)
//                                          o si el push es forzado (esto ultimo,
//                                          solo en modo equipo).
//   PostToolUse · gh pr create / edit   -> los tres grupos contra el PR, un
//                                          comentario con el resultado en el PR
//                                          (la evidencia para el revisor) y el
//                                          resultado de vuelta al agente: block
//                                          si falla secretos o pr-metadata.
//   Manual      · node .claude/hooks/reglas-pr.mjs --pr <url>
//                                       -> lo mismo que el PostToolUse, para
//                                          despues de un push correctivo (que no
//                                          vuelve a disparar el hook) o si el
//                                          hook no corrio.
//
// Es un hook de Claude Code, no un git hook. Corre en cada comando de shell, sin
// filtro `if` en settings.json (`git -C <ruta> push` no empieza por `git push` y
// se le escapaba), y se filtra solo: sin push ni PR en el comando termina sin
// hacer nada. Falla abierto ante problemas de infraestructura (sin gh, sin red,
// sin el script): no frena por no poder verificar, pero lo avisa. El check de
// secretos no aplica en repos sin scripts/check-pr-rules.mjs (el Vault, por
// ejemplo). En modo solo corre solo el check de secretos antes del push: cubre
// tambien los merges directos a dev/main, que en solo no pasan por ningun PR.
//
// Limite: el hook lee el TEXTO del comando. Ve el push a traves de envoltorios
// (`command git push`), agrupaciones (`(git push)`), comandos anidados (`bash
// -c`, `eval`) y lanzadores (`start`, `Start-Process`), y sigue los `cd` que
// de verdad cambian la carpeta de lo que viene despues (no el de un subshell,
// una tuberia o `nohup cd`); si no puede saber en que carpeta corre el push,
// pregunta. No ve el push que hace un script (`./deploy.sh`), otro programa
// (`make`, `python -c`), un alias configurado en git, una llamada a la API
// (`gh api`) ni lo que va dentro de una sustitucion entre comillas dobles
// (`"$(git push)"`). Es una red para el error honesto; la barrera de `main` es
// la proteccion de rama en GitHub.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENTORNO ={ ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }
const MARCA = '<!-- souclaude:reglas-pr -->'
const LIMITE_SALIDA = 60_000
const MAX_AVISOS = 20

// rama-commits es informativo desde SHS-M33: un nombre de rama o un commit con
// otro formato no traba nada. secretos y pr-metadata si bloquean.
const GRUPOS = [
  { grupo: 'rama-commits', bloqueante: false },
  { grupo: 'secretos', bloqueante: true },
  { grupo: 'pr-metadata', bloqueante: true },
]

// --- Lectura del comando ---------------------------------------------------

// Parte un comando de shell por sus operadores de control (&&, ||, |, ;, &,
// saltos de linea), por los parentesis de un subshell o de una sustitucion de
// comando -- `(git push)`, `$(git push)` -- y, en bash, por los backticks, sin
// cortar dentro de comillas: `git commit -m "x; git push"` es un solo segmento.
// Las redirecciones (2>&1, &>) no son operadores, y un comentario (`# ...`) no
// es parte de ningun segmento.
export function segmentos(comando, shell = 'bash') {
  return piezasDe(comando, shell)
    .map((pieza) => pieza.texto.trim())
    .filter(Boolean)
}

const ABRE = new Set(['(', '`('])
const CIERRA = new Set([')', '`)'])

// Lo mismo, pieza por pieza y sin descartar las vacias: el texto tal cual
// (`desde` y `hasta` son su posicion en el comando) y `corte`, el operador que
// la termino. Un salto de linea cuenta como `;`. `(` y `)` abren y cierran una
// expresion, y en bash un par de backticks tambien (`\`(` y `\`)`). `shell` es
// 'bash' (y los que se le parecen), 'powershell' o 'cmd'; en cmd un `&` suelto
// no manda nada al fondo: separa comandos que corren uno tras otro, como `;`.
//
// Un `#` al comienzo de una palabra abre un comentario hasta el fin de la linea
// (en bash y en PowerShell; en cmd no): su texto se descarta. Sin eso, el
// apostrofo de `# don't ...` abria una comilla que se tragaba las lineas
// siguientes, y el push que hubiera en ellas no se veia.
export function piezasDe(comando, shell = 'bash') {
  const escape = shell === 'powershell' ? '`' : '\\'
  const piezas = []
  let desde = 0
  let comilla = null
  let enBackticks = false
  let enPalabra = false
  const cortar = (hasta, corte, largo = 1) => {
    piezas.push({ texto: comando.slice(desde, hasta), desde, hasta, corte })
    desde = hasta + largo
  }
  for (let i = 0; i < comando.length; i++) {
    const c = comando[i]
    if (comilla) {
      if (c === escape && comilla === '"' && i + 1 < comando.length) i++
      else if (c === comilla) comilla = null
      continue
    }
    const empiezaPalabra = !enPalabra
    enPalabra = true
    if (c === "'" || c === '"') {
      comilla = c
    } else if (c === escape && i + 1 < comando.length) {
      i++
    } else if (c === '&' && ((i > desde && /[<>]/.test(comando[i - 1])) || comando[i + 1] === '>')) {
      // 2>&1, &>: una redireccion, no un operador.
    } else if (c === '#' && empiezaPalabra && shell !== 'cmd') {
      // Comentario: hasta el fin de la linea no hay nada que se ejecute.
      const fin = comando.indexOf('\n', i)
      cortar(i, ';', (fin === -1 ? comando.length : fin) - i)
      i = desde - 1
      enPalabra = false
    } else if (c === '`' && shell === 'bash') {
      cortar(i, enBackticks ? '`)' : '`(')
      // Lo que sigue al backtick que abre es el comienzo de un comando; lo que
      // sigue al que cierra (`x=\`cmd\`#y`) es parte de la misma palabra.
      enPalabra = enBackticks
      enBackticks = !enBackticks
    } else if (c === '(' || c === ')') {
      cortar(i, c)
      enPalabra = c === ')'
    } else if (c === ';' || c === '\n' || c === '\r') {
      cortar(i, ';')
      enPalabra = false
    } else if (c === '&' || c === '|') {
      // `&&` y `||` son un solo operador; `|&` es una tuberia (con stderr).
      const largo = comando[i + 1] === c || (c === '|' && comando[i + 1] === '&') ? 2 : 1
      const corte = comando[i + 1] === c ? c + c : c === '&' && shell === 'cmd' ? ';' : c
      cortar(i, corte, largo)
      i += largo - 1
      enPalabra = false
    } else if (/\s/.test(c)) {
      enPalabra = false
    }
  }
  cortar(comando.length, '')
  return piezas
}

// Palabras de un segmento, sin comillas. Descarta las redirecciones (2>&1,
// > archivo) y las asignaciones iniciales (VAR=valor git push). Una expresion
// entre parentesis o entre backticks (`$(cat rama.txt)`) queda entera dentro de
// su palabra: sus espacios no separan.
export function palabras(segmento, shell = 'bash') {
  const escape = shell === 'powershell' ? '`' : '\\'
  const crudas = []
  let actual = ''
  let hay = false
  let comilla = null
  let profundidad = 0
  let enBackticks = false
  for (let i = 0; i < segmento.length; i++) {
    const c = segmento[i]
    if (comilla) {
      // En bash, dentro de comillas dobles la barra solo escapa " \ $ ` y el
      // salto de linea: "C:\Users\x" queda tal cual. En PowerShell, el
      // backtick escapa cualquier caracter.
      const escapado = segmento[i + 1] ?? ''
      if (c === comilla) comilla = null
      else if (c === escape && comilla === '"' && (shell === 'powershell' ? escapado !== '' : /["\\$`\n]/.test(escapado))) actual += segmento[++i]
      else actual += c
      continue
    }
    if (c === "'" || c === '"') {
      comilla = c
      hay = true
    } else if (c === escape && i + 1 < segmento.length) {
      actual += segmento[++i]
      hay = true
    } else if (/\s/.test(c) && profundidad === 0 && !enBackticks) {
      if (hay) crudas.push(actual)
      actual = ''
      hay = false
    } else {
      if (c === '(') profundidad++
      else if (c === ')' && profundidad > 0) profundidad--
      else if (c === '`' && shell === 'bash') enBackticks = !enBackticks
      actual += c
      hay = true
    }
  }
  if (hay) crudas.push(actual)

  const sinRedireccion = []
  for (let i = 0; i < crudas.length; i++) {
    const m = crudas[i].match(/^(\d*|&)?(>>?|<)(&\d+|&-)?(.*)$/)
    if (m) {
      if (!m[3] && m[4] === '') i++ // operador solo: la palabra siguiente es el archivo
      continue
    }
    sinRedireccion.push(crudas[i])
  }
  let desde = 0
  while (desde < sinRedireccion.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(sinRedireccion[desde])) desde++
  return sinRedireccion.slice(desde)
}

const ES_GIT = /(^|[\\/])git(\.exe)?$/i
const ES_GH = /(^|[\\/])gh(\.exe)?$/i
const ES_CD = /^(cd|chdir|set-location|sl)$/i
const ES_PUSHD = /^(pushd|push-location)$/i
const ES_POPD = /^(popd|pop-location)$/i
const ES_SHELL = /(^|[\\/])(ba|z|da|k|a)?sh(\.exe)?$/i
const ES_POWERSHELL = /(^|[\\/])(powershell|pwsh)(\.exe)?$/i
const ES_CMD = /(^|[\\/])cmd(\.exe)?$/i
const ES_EVAL = /^(eval|iex|invoke-expression)$/i
// Programas que LANZAN otro con una sintaxis que no es la de un shell: `start`
// (cmd y Git Bash) y, en PowerShell, `Start-Process`/`saps`, `Invoke-Command`/
// `icm` y `Start-Job`/`sajb`.
const ES_LANZADOR = /^(start|start-process|saps|invoke-command|icm|start-job|sajb)$/i
const OPCIONES_PUSH_CON_VALOR = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
// El refspec "matching": `:` a secas (o `+:`) sube todas las ramas que existen
// con el mismo nombre en los dos lados -- main incluida --, igual que --all.
const REFSPEC_MATCHING = /^\+?:$/

// Lo que puede ir DELANTE de un comando sin cambiar cual es. Los envoltorios son
// los que el propio Claude Code quita antes de comparar con las reglas de
// permisos (timeout, time, nice, nohup, stdbuf, command, builtin, noglob, xargs)
// mas env, exec y sudo/doas: como `command git push origin main` casa con la
// regla allow `Bash(git push:*)`, ese push pasaba sin pregunta Y sin que este
// hook lo viera. Las palabras de control son las de un if/while/grupo de shell.
const ENVOLTORIOS = new Set(['command', 'builtin', 'exec', 'time', 'nice', 'nohup', 'stdbuf', 'timeout', 'noglob', 'env', 'sudo', 'doas', 'xargs'])
// De esos, los que son del propio shell: lo que envuelven corre en el mismo
// proceso. Un `cd` detras de cualquier otro (`nohup cd x`, `env cd x`) corre en
// un proceso aparte y no mueve la carpeta de lo que sigue.
const ENVOLTORIOS_DEL_SHELL = new Set(['command', 'builtin', 'time', 'noglob'])
const PALABRAS_DE_CONTROL = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
const PROFUNDIDAD_MAXIMA = 4

// El comando que un segmento ejecuta de verdad, sin lo que lo envuelve.
// `viaXargs`: sus argumentos llegan por stdin y no se pueden leer del texto.
// `envoltorios`: los que se le quitaron, en orden.
export function comandoEfectivo(palabrasDelSegmento) {
  let p = [...palabrasDelSegmento]
  let viaXargs = false
  const envoltorios = []
  // `git push` entre backticks, o {git push} pegado a las llaves (PowerShell).
  const abre = p[0]?.match(/^[`{]+/)?.[0]
  if (abre) {
    p[0] = p[0].slice(abre.length)
    p[p.length - 1] = p[p.length - 1].replace(/[`};]+$/, '')
    p = p.filter(Boolean)
  }
  for (let vueltas = 0; vueltas < 12 && p.length; vueltas++) {
    if (PALABRAS_DE_CONTROL.has(p[0])) {
      p.shift()
      continue
    }
    const nombre = p[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
    if (!ENVOLTORIOS.has(nombre)) break
    if (nombre === 'xargs') viaXargs = true
    envoltorios.push(nombre)
    p.shift()
    // Opciones del envoltorio, asignaciones de env y duraciones de timeout/nice.
    while (p.length && (p[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(p[0]) || /^\d+(\.\d+)?[smhd]?$/.test(p[0]))) p.shift()
  }
  return { p, viaXargs, envoltorios }
}

// Un comando escrito dentro de otro: `bash -c "..."`, `eval "..."`,
// `powershell -Command "..."`, `cmd /c ...`. Devuelve el texto a analizar.
export function comandoAnidado(p, shell = 'bash') {
  const primero = p[0] ?? ''
  if (ES_EVAL.test(primero)) return p.length > 1 ? { comando: p.slice(1).join(' '), shell } : null
  if (ES_SHELL.test(primero)) {
    const i = p.findIndex((w, k) => k > 0 && /^-[a-zA-Z]*c$/.test(w))
    return i !== -1 && p[i + 1] != null ? { comando: p[i + 1], shell: 'bash' } : null
  }
  if (ES_POWERSHELL.test(primero)) {
    const i = p.findIndex((w, k) => k > 0 && /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(w))
    return i !== -1 && p[i + 1] != null ? { comando: p.slice(i + 1).join(' '), shell: 'powershell' } : null
  }
  if (ES_CMD.test(primero)) {
    const i = p.findIndex((w, k) => k > 0 && /^\/[ck]$/i.test(w))
    return i !== -1 && p[i + 1] != null ? { comando: p.slice(i + 1).join(' '), shell: 'cmd' } : null
  }
  return null
}

// Los argumentos del `git push` que lanza un `start` / `Start-Process` /
// `Invoke-Command`, o null si no lanza ninguno. Las listas de PowerShell
// (`"push","origin","main"`, `'push origin main'`) y los bloques (`{ git push }`)
// se abren en palabras sueltas. Es una lectura aproximada: quien la usa marca
// el push como incierto.
export function pushLanzado(resto) {
  const piezas = resto
    // La ruta de git puede traer espacios (`C:\Program Files\Git\cmd\git.exe`): no se parte.
    .flatMap((w) => (ES_GIT.test(w) ? [w] : w.split(/[\s,;]+/)))
    .map((w) => w.replace(/^['"({@]+|['")}]+$/g, ''))
    .filter(Boolean)
  if (!piezas.some((w) => ES_GIT.test(w))) return null
  const i = piezas.indexOf('push')
  return i === -1 ? null : piezas.slice(i + 1).filter((w) => !ES_GIT.test(w))
}

// En Git Bash sobre Windows el agente escribe rutas MSYS (`/c/Users/...`), que
// path.resolve leeria como relativas a la raiz de la unidad actual
// (`C:\c\Users\...`): la carpeta no existiria y el push quedaria sin revisar.
// Se traducen a su forma nativa (`C:/Users/...`) antes de resolverlas.
export function rutaNativa(ruta, plataforma = process.platform) {
  const m = plataforma === 'win32' ? ruta.match(/^\/([a-zA-Z])(\/.*)?$/) : null
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : ruta
}

// Lo que el shell resuelve recien al ejecutar dentro de una ruta: variables y
// sustituciones. Los comodines quedan fuera a proposito (`[` y `*` aparecen en
// nombres de carpeta reales); `~`, `$HOME`, `$PWD` y `$(pwd)` si se pueden
// resolver aca.
const DINAMICO_EN_RUTA = /[$`]|%[A-Za-z_][A-Za-z0-9_]*%/
const HOGAR = /^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i
const AQUI = /^(\$PWD|\$\{PWD\}|\$\(\s*pwd\s*\)|`\s*pwd\s*`|%CD%)(?=$|[\\/])/i

function esCarpeta(ruta) {
  try {
    return fs.statSync(ruta).isDirectory()
  } catch {
    return false
  }
}

function rutaExpandida(actual, destino) {
  if (destino === '~' || /^~[\\/]/.test(destino)) return path.join(os.homedir(), destino.slice(1))
  return rutaNativa(destino.replace(HOGAR, () => os.homedir()).replace(AQUI, () => actual))
}

// La carpeta a la que lleva `cd <destino>` (o `git -C <destino>`) desde
// `actual`, o null si el destino sale de una variable o de una sustitucion y no
// se puede leer del texto.
function carpetaTrasCd(actual, destino) {
  const expandida = rutaExpandida(actual, destino)
  const ruta = path.resolve(actual, expandida)
  return DINAMICO_EN_RUTA.test(expandida) && !esCarpeta(ruta) ? null : ruta
}

const dudaDeCarpeta = (motivo) => `no se sabe en que carpeta corre (${motivo})`

// Aplica un `cd`, `pushd` o `popd` al estado de carpeta `e`, si de verdad
// cambia la carpeta de lo que viene despues, y devuelve true si la cambio. No la
// cambia el que corre en otro proceso: detras de un envoltorio que no es del
// shell (`nohup cd x`), dentro de una tuberia (`cd x | tee log`) o mandado al
// fondo (`cd x &`). Cuando no se puede saber, deja la carpeta como estaba y
// anota el motivo en `e.duda`: prePushMain pregunta en vez de adivinar.
function cambiarDeCarpeta(e, p, { antes, despues, envoltorios, shell }) {
  const nombre = p[0]
  if (!envoltorios.every((x) => ENVOLTORIOS_DEL_SHELL.has(x))) return false
  if (despues === '&') return false
  // En PowerShell una tuberia corre en el mismo proceso; en bash y en cmd, no.
  if (shell !== 'powershell' && despues === '|') return false
  if (shell === 'cmd' && antes === '|') return false
  if (shell === 'bash' && antes === '|') {
    // El ultimo comando de una tuberia corre en el shell actual en zsh y en un
    // subshell en bash.
    e.duda = dudaDeCarpeta(`\`${nombre}\` cierra una tuberia, y que cambie o no la carpeta depende del shell`)
    return false
  }
  const mover = (nueva) => {
    e.anterior = e.carpeta
    e.carpeta = nueva
    return true
  }
  // Cada comando corre en un shell nuevo: sin un pushd previo en el mismo
  // comando, la pila esta vacia y `popd` falla sin mover nada.
  if (ES_POPD.test(nombre)) return e.pila.length ? mover(e.pila.pop()) : false
  const args = p.slice(1).filter((x) => !(shell === 'cmd' && /^\/d$/i.test(x)))
  if (ES_PUSHD.test(nombre) && args.some((x) => /^[+-]\d+$/.test(x))) {
    e.duda = dudaDeCarpeta(`\`${p.join(' ')}\` rota una pila de carpetas que este comando no deja ver`)
    return false
  }
  const destino = args.find((x) => !x.startsWith('-'))
  if (destino == null) {
    if (ES_PUSHD.test(nombre)) {
      // `pushd` a secas intercambia la carpeta actual con la ultima apilada.
      if (!e.pila.length) return false
      const tope = e.pila.pop()
      e.pila.push(e.carpeta)
      return mover(tope)
    }
    if (!args.includes('-')) return false
    if (e.anterior != null) return mover(e.anterior)
    e.duda = dudaDeCarpeta(`\`${nombre} -\` vuelve a una carpeta que este comando no nombra`)
    return false
  }
  const expandida = rutaExpandida(e.carpeta, destino)
  const ruta = path.resolve(e.carpeta, expandida)
  if (DINAMICO_EN_RUTA.test(expandida) && !esCarpeta(ruta)) {
    e.duda = dudaDeCarpeta(`el destino de \`${nombre} ${destino}\` se resuelve recien al ejecutar`)
    return false
  }
  if (ES_PUSHD.test(nombre)) e.pila.push(e.carpeta)
  // Una ruta absoluta vuelve a dejar en claro donde se esta.
  if (path.isAbsolute(expandida)) e.duda = null
  return mover(ruta)
}

// `$(git branch --show-current)` y sus equivalentes SI se pueden leer del
// texto: son la rama actual, lo mismo que HEAD. Es la forma habitual de pushear
// "esta rama" en un script, y tratarla como incierta seria preguntar de mas.
const NOMBRE_DE_LA_RAMA_ACTUAL = String.raw`git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+--short\s+HEAD)`
const SUSTITUCION_DE_LA_RAMA_ACTUAL = new RegExp(String.raw`\$\(\s*${NOMBRE_DE_LA_RAMA_ACTUAL}\s*\)|` + '`\\s*' + NOMBRE_DE_LA_RAMA_ACTUAL + '\\s*`', 'g')
// Lo mismo con `$(git rev-parse --show-toplevel)`: es la raiz del repo en el
// que ya esta la carpeta actual. Para saber a que repo va el push, `cd` ahi es
// quedarse donde se esta (`.`).
const RAIZ_DEL_REPO_ACTUAL = String.raw`git\s+rev-parse\s+--show-toplevel`
const SUSTITUCION_DE_LA_RAIZ_DEL_REPO = new RegExp(String.raw`\$\(\s*${RAIZ_DEL_REPO_ACTUAL}\s*\)|` + '`\\s*' + RAIZ_DEL_REPO_ACTUAL + '\\s*`', 'g')

// Los comandos de los que este hook lee algo. Uno de estos cortado por una
// expresion (`git push $(echo origin) main`) se lee entero, con lo que sigue al
// cierre: `main` es parte del mismo comando.
const SE_LEE = [ES_CD, ES_PUSHD, ES_POPD, ES_GIT, ES_GH, ES_LANZADOR, ES_SHELL, ES_POWERSHELL, ES_CMD, ES_EVAL]

// Cada comando que el texto ejecuta: `p` (sus palabras, sin lo que lo
// envuelve), la `carpeta` en la que corre y `duda`, el motivo cuando esa
// carpeta no se puede saber con certeza. Mira a traves de envoltorios (`command
// git push`), agrupaciones (`(git push)`, `if ...; then git push; fi`) y
// comandos anidados (`bash -c`, `eval`), y sigue los `cd`, `pushd` y `popd`.
//
// La carpeta la mueve solo el `cd` que llega a lo que viene despues. En bash,
// el de un subshell o una sustitucion -- `(cd x)`, `$(cd x)` -- termina con
// ella: al cerrar el parentesis vuelve la carpeta de antes. En PowerShell y en
// cmd un parentesis no abre otro proceso, y ese `cd` queda.
function* comandosDe(comando, cwd, shell = 'bash', nivel = 0, { estado = null, duda = null } = {}) {
  const texto = comando.replace(SUSTITUCION_DE_LA_RAMA_ACTUAL, 'HEAD').replace(SUSTITUCION_DE_LA_RAIZ_DEL_REPO, '.')
  const piezas = piezasDe(texto, shell)
  // Para cada pieza que abre una expresion, la pieza en la que esa expresion cierra.
  const cierreDe = new Map()
  const abiertas = []
  piezas.forEach((pieza, k) => {
    if (ABRE.has(pieza.corte)) abiertas.push(k)
    else if (CIERRA.has(pieza.corte) && abiertas.length) cierreDe.set(abiertas.pop(), k)
  })

  let e = estado ?? { carpeta: cwd, anterior: null, pila: [], duda }
  const ambitos = []
  const yaLeidas = new Set()
  let siFallo = null
  let antes = ''
  for (let k = 0; k < piezas.length; k++) {
    const pieza = piezas[k]
    if (!yaLeidas.has(k) && pieza.texto.trim()) {
      let { p, viaXargs, envoltorios } = comandoEfectivo(palabras(pieza.texto, shell))
      let despues = pieza.corte
      // Los parentesis vacios son los de una definicion de funcion (`git() { ... }`),
      // no una expresion: lo que sigue es su cuerpo, y se lee como comandos.
      const defineFuncion = cierreDe.get(k) === k + 1 && !piezas[k + 1].texto.trim()
      if (ABRE.has(pieza.corte) && !defineFuncion && SE_LEE.some((forma) => forma.test(p[0] ?? ''))) {
        // Lo corto una expresion: sigue despues de su cierre, y del de las que vengan.
        let fin = k
        while (ABRE.has(piezas[fin].corte)) {
          const cierre = cierreDe.get(fin)
          if (cierre == null) {
            fin = piezas.length - 1
            break
          }
          fin = cierre + 1
          yaLeidas.add(fin)
        }
        ;({ p, viaXargs, envoltorios } = comandoEfectivo(palabras(texto.slice(pieza.desde, piezas[fin].hasta), shell)))
        despues = piezas[fin].corte
      }
      // Lo que sigue a `cd x ||` corre solo si ese cd fallo: en la carpeta de antes.
      const aqui = siFallo ?? e
      siFallo = null
      const nombre = p[0] ?? ''
      if (ES_CD.test(nombre) || ES_PUSHD.test(nombre) || ES_POPD.test(nombre)) {
        const previo = { ...e, pila: [...e.pila] }
        if (cambiarDeCarpeta(e, p, { antes, despues, envoltorios, shell }) && despues === '||') siFallo = previo
      } else {
        const anidado = nivel < PROFUNDIDAD_MAXIMA ? comandoAnidado(p, shell) : null
        if (anidado) {
          // `eval` e `iex` corren en este mismo shell y su `cd` queda; el de
          // `bash -c "cd x"` termina con ese proceso.
          yield* comandosDe(anidado.comando, aqui.carpeta, anidado.shell, nivel + 1, ES_EVAL.test(nombre) ? { estado: aqui } : { duda: aqui.duda })
        } else if (p.length) {
          yield { p, viaXargs, carpeta: aqui.carpeta, duda: aqui.duda }
        }
      }
    }
    if (shell === 'bash') {
      if (ABRE.has(pieza.corte)) {
        ambitos.push(e)
        e = { ...e, pila: [...e.pila] }
      } else if (CIERRA.has(pieza.corte) && ambitos.length) {
        e = ambitos.pop()
      }
    }
    antes = pieza.corte
  }
}

// Cada `git push` del comando, con la carpeta efectiva en la que corre (el cwd
// mas los cd y -C previos) y sus argumentos: sin `git`, sus opciones globales
// ni `push`. `incierto` lleva el motivo cuando el texto no alcanza para saber
// que se sube (xargs, un alias de git definido en la misma linea, un programa
// que lo lanza); `duda`, cuando no alcanza para saber en que carpeta corre.
function* pushes(comando, cwd, shell = 'bash') {
  for (const { p, viaXargs, carpeta, duda: dudaPrevia } of comandosDe(comando, cwd, shell)) {
    if (ES_LANZADOR.test(p[0])) {
      // `start git push origin main`, `Start-Process git -ArgumentList push,origin,main`:
      // lo que se alcanza a leer decide si toca main; el resto se pregunta.
      const lanzado = pushLanzado(p.slice(1))
      if (lanzado) yield { dir: carpeta, args: lanzado, incierto: `lo lanza \`${p[0]}\`, que no deja leer sus argumentos con certeza`, duda: dudaPrevia }
      continue
    }
    if (!ES_GIT.test(p[0])) continue

    let i = 1
    let dir = carpeta
    let duda = dudaPrevia
    let alias = false
    while (i < p.length && p[i].startsWith('-')) {
      if (p[i] === '-C') {
        const ruta = carpetaTrasCd(dir, p[i + 1] ?? '.')
        if (ruta == null) duda ??= dudaDeCarpeta(`la ruta de \`git -C ${p[i + 1]}\` se resuelve recien al ejecutar`)
        else dir = ruta
        i += 2
      } else if (['-c', '--git-dir', '--work-tree', '--namespace'].includes(p[i])) {
        if (p[i] === '-c' && /^alias\./i.test(p[i + 1] ?? '')) alias = true
        i += 2
      } else {
        i += 1
      }
    }
    if (p[i] !== 'push') {
      // `git send-pack <remoto> <ref>...` es la forma interna de `git push`: se lee
      // igual, y se pregunta si no toca main.
      if (p[i] === 'send-pack') yield { dir, args: p.slice(i + 1), incierto: 'usa `git send-pack`, la forma interna de `git push`', duda }
      // `git -c alias.p=push p origin main`: el subcomando real no se ve.
      else if (alias) yield { dir, args: [], incierto: 'usa un alias de git definido en la misma linea', duda }
      continue
    }
    yield { dir, args: p.slice(i + 1), incierto: viaXargs ? 'sus argumentos llegan por xargs' : null, duda }
  }
}

// Variables, sustituciones de comando y comodines: lo que el shell resuelve
// recien al ejecutar, y que este hook no puede leer del texto del comando.
const DINAMICO = /[$`*?[]|%[A-Za-z_][A-Za-z0-9_]*%/
// `(Get-Content rama.txt)`, `@(...)`: una expresion de PowerShell como argumento.
const EXPRESION = /^@?\(/

// El flag o refspec que vuelve forzado a un push, o null. Cubre lo que las reglas
// `ask` de settings.json no ven por ser de prefijo: el flag al final
// (`git push origin x --force`), agrupado (`-uf`) o como `+refspec`.
export function pushForzado(args) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j]
    if (OPCIONES_PUSH_CON_VALOR.has(a)) {
      j++
    } else if (/^--force(-with-lease|-if-includes)?(=|$)/.test(a)) {
      return a
    } else if (/^-[a-zA-Z0-9]*f[a-zA-Z0-9]*$/.test(a)) {
      return a
    } else if (a.startsWith('+')) {
      return a
    }
  }
  return null
}

// Lo que el primer `git push` del comando subiria, o null si no sube commits:
// los borrados de ramas remotas y los comandos sin push no llevan check de
// secretos. `cabezas` son las revs cuyos commits sin pushear hay que revisar:
// la rama o el tag del refspec, HEAD por defecto, y --branches / --tags para
// --all, --mirror y --tags (un tag sobre un commit sin pushear tambien lo sube).
export function pushDelComando(comando, cwd, shell = 'bash') {
  for (const { dir, args } of pushes(comando, cwd, shell)) {
    const posicionales = []
    const extra = []
    for (let j = 0; j < args.length; j++) {
      const arg = args[j]
      if (arg === '--delete' || arg === '-d') return null
      if (arg === '--tags' || arg === '--follow-tags') extra.push('--tags')
      if (arg === '--all' || arg === '--branches') extra.push('--branches')
      if (arg === '--mirror') extra.push('--branches', '--tags')
      if (OPCIONES_PUSH_CON_VALOR.has(arg)) {
        j++
      } else if (!arg.startsWith('-')) {
        posicionales.push(arg)
      }
    }
    const refspecs = posicionales.slice(1)
    const cabezas = []
    for (const refspec of refspecs) {
      if (REFSPEC_MATCHING.test(refspec)) {
        extra.push('--branches')
        continue
      }
      if (refspec.startsWith(':')) continue // borrar la rama remota
      const origen = refspec.replace(/^\+/, '').split(':')[0]
      // Un origen que se resuelve recien al ejecutar (`$RAMA`, `$(...)`) no se
      // puede revisar: se revisa HEAD, lo mas probable. Ese push ya se pregunta.
      cabezas.push(origen === '' || origen === '@' || DINAMICO.test(origen) || EXPRESION.test(origen) ? 'HEAD' : origen)
    }
    // Sin refspec, push de la rama actual; --tags solo, en cambio, no la sube.
    if (refspecs.length === 0 && !extra.includes('--branches') && !(extra.includes('--tags') && !args.includes('--follow-tags'))) {
      cabezas.push('HEAD')
    }
    cabezas.push(...extra)
    return cabezas.length ? { dir, cabezas: [...new Set(cabezas)] } : null
  }
  return null
}

// Comodines de destinosDelPush que resuelve git en la carpeta del push.
const RAMA_ACTUAL = '@rama-actual'
const UPSTREAM = '@upstream'
const TODAS = '*'

const ramaCorta = (ref) => ref.replace(/^refs\/heads\//, '')

// Ramas remotas que cada `git push` del comando escribiria o borraria, para la
// proteccion de main: el lado destino de cada refspec (`dev:main`,
// `HEAD:refs/heads/main`, `:main` y `--delete main` tocan main; `origin main`
// sube main a main), TODAS para --all/--branches/--mirror y, con `HEAD` o sin
// refspec, la rama actual (sin refspec, tambien su upstream: con
// push.default=upstream iria a ella). Un push solo de tags no toca ramas. Viaja
// tambien el remoto nombrado (`remoto`; null = el de la rama, normalmente
// origin), que sirve para reconocer el Vault por su URL.
export function destinosDelPush(comando, cwd, shell = 'bash') {
  const salida = []
  for (const { dir, args, incierto: inciertoDelComando = null, duda = null } of pushes(comando, cwd, shell)) {
    const posicionales = []
    const destinos = []
    let soloTags = false
    for (let j = 0; j < args.length; j++) {
      const arg = args[j]
      if (arg === '--all' || arg === '--branches' || arg === '--mirror') destinos.push(TODAS)
      if (arg === '--tags') soloTags = true
      if (OPCIONES_PUSH_CON_VALOR.has(arg)) {
        j++
      } else if (!arg.startsWith('-')) {
        posicionales.push(arg)
      }
    }
    const refspecs = posicionales.slice(1)
    // Ramas remotas que este push BORRA: `--delete rama` / `-d rama` y `:rama`.
    const borraTodo = args.some((a) => a === '--delete' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a))
    const borra = []
    for (const refspec of refspecs) {
      if (REFSPEC_MATCHING.test(refspec)) {
        destinos.push(TODAS)
        continue
      }
      const [origen, destino] = refspec.replace(/^\+/, '').split(':')
      const ref = destino ?? origen
      destinos.push(ref === 'HEAD' || ref === '@' ? RAMA_ACTUAL : ramaCorta(ref))
      if (borraTodo || refspec.startsWith(':')) borra.push(ramaCorta(ref))
    }
    // Lo que el shell resuelve recien al ejecutar (`$RAMA`, `$(...)`, un comodin
    // en el refspec, una expresion entre parentesis de PowerShell) no se puede
    // leer del texto: viaja como `incierto`, con el motivo, para que prePushMain
    // pregunte en vez de dejarlo pasar en silencio. Lo mismo si lo que no se
    // puede leer es la carpeta (`dudaDeCarpeta`).
    const dinamico = posicionales.find((w) => DINAMICO.test(w))
    const deLosArgumentos = posicionales.some((w) => EXPRESION.test(w))
      ? 'parte de sus argumentos sale de una expresion entre parentesis'
      : dinamico
        ? `"${dinamico}" se resuelve recien al ejecutar`
        : null
    const incierto = inciertoDelComando ?? deLosArgumentos ?? duda
    const forzado = pushForzado(args)
    // Sin refspec sube la rama actual, tambien cuando lo unico que no se puede
    // leer es el remoto (`git push $REMOTO`) o la carpeta. No cuando los
    // argumentos llegan por otro lado (xargs, un alias, un lanzador).
    if (refspecs.length === 0 && destinos.length === 0 && !soloTags && !inciertoDelComando) destinos.push(RAMA_ACTUAL, UPSTREAM)
    if (destinos.length || incierto || forzado) {
      salida.push({ dir, remoto: posicionales[0] ?? null, destinos: [...new Set(destinos)], incierto, forzado, borra: [...new Set(borra)], dudaDeCarpeta: duda })
    }
  }
  return salida
}

const FLAGS_DE_METADATA = /^(--body|-b|--body-file|-F|--base|-B)(=|$)/

// `gh pr create` o un `gh pr edit` que toca body o base (lo que valida
// pr-metadata). `objetivo` es el numero/URL/rama que se le paso a edit.
export function cambioDePR(comando, cwd, shell = 'bash') {
  for (const { p, carpeta } of comandosDe(comando, cwd, shell)) {
    if (!ES_GH.test(p[0]) || p[1] !== 'pr') continue
    const args = p.slice(3)
    if (p[2] === 'create') {
      if (args.some((a) => a === '--web' || a === '-w' || a === '--dry-run')) continue
      return { accion: 'create', dir: carpeta, objetivo: null }
    }
    if (p[2] === 'edit' && args.some((a) => FLAGS_DE_METADATA.test(a))) {
      const objetivo = args[0] && !args[0].startsWith('-') ? args[0] : null
      return { accion: 'edit', dir: carpeta, objetivo }
    }
  }
  return null
}

// La ultima URL de PR en la salida de la tool. La forma de tool_response no
// esta documentada, asi que se busca en todo su JSON; host, owner y repo van
// acotados para que dos URLs seguidas no se lean como una sola.
export function urlDelPR(texto) {
  const todas = String(texto ?? '').match(/https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)
  return todas ? todas.at(-1) : null
}

// --- Checks ------------------------------------------------------------------

function correrReal(cmd, args, { cwd, timeout = 30_000, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: ENTORNO, encoding: 'utf8', timeout, input, windowsHide: true })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

function primeraLinea(r) {
  if (r.error?.code === 'ENOENT') return `no se encontro "${r.error.path ?? 'el comando'}" en el PATH`
  if (r.error?.code === 'ETIMEDOUT') return 'se agoto el tiempo de espera'
  return (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().split('\n')[0]
}

function raizDelRepo(dir, correr) {
  const r = correr('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim() : null
}

function rutaDelScript(raiz) {
  return path.join(raiz, 'scripts', 'check-pr-rules.mjs')
}

// El script que se EJECUTA es siempre el del proyecto al que pertenece este
// hook (.claude/hooks/ -> la raiz), nunca el del repo destino del comando: un
// PreToolUse corre antes del prompt de permisos, y `cd <repo ajeno> && git push`
// no puede servir para ejecutar un check-pr-rules.mjs de terceros. El del repo
// destino solo se mira (existencia) para decidir si le corresponde el check.
const RAIZ_DEL_HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT_CONFIABLE = rutaDelScript(RAIZ_DEL_HOOK)

function enModoSolo(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(raiz, '.claude', 'harness.json'), 'utf8')).modo === 'solo'
  } catch {
    return false
  }
}

// El repo donde corre el comando, si le corresponde el check: con el script
// del harness. El Vault y cualquier otro repo quedan fuera. Los checks del PR
// son solo de modo equipo (en solo no hay plantilla ni validacion de PR); el
// de secretos antes del push corre en los dos modos: en solo es la unica regla
// dura, y los merges directos a dev/main se pushean sin pasar por ningun PR.
function repoConReglas(dir, correr, { tambienEnSolo = false } = {}) {
  const raiz = dir ? raizDelRepo(dir, correr) : null
  if (!raiz || !fs.existsSync(rutaDelScript(raiz)) || !fs.existsSync(SCRIPT_CONFIABLE)) return null
  if (!tambienEnSolo && enModoSolo(raiz)) return null
  return raiz
}

// --- Proteccion de main por repo (SHS-M42) -----------------------------------
//
// `main` del proyecto solo recibe merges desde `dev` por PR: ningun push la
// toca. La regla vive aca y no en permissions.deny de settings.json porque una
// regla por texto no sabe en que repo corre el comando: `git push origin main`
// es una violacion en el proyecto y es el protocolo en el Vault (push directo a
// main, sin PR); y `git -C <ruta> push origin main` ni siquiera empieza por
// `git push`. El hook resuelve la carpeta real del push (cwd, cd, -C) y exime al
// Vault —por su ruta configurada (.claude/vault.local.json, VAULT_PATH o la
// config de maquina, en el mismo orden que el CLI), por su remoto o por su
// carpeta 00-System, para que un clon del Vault se reconozca en los dos modos
// aunque esta maquina no lo tenga configurado— y al modo solo, donde el agente
// mergea y pushea main a proposito.

const RAMA_PROTEGIDA = 'main'

function leerJson(ruta) {
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'))
  } catch {
    return null
  }
}

// Config del Vault en esta maquina: las rutas y las URLs de remoto (`repo`)
// declaradas en .claude/vault.local.json del proyecto, VAULT_PATH y la config de
// maquina, en el mismo orden que readVaultConfig del CLI.
export function configDelVault({ raizProyecto = RAIZ_DEL_HOOK, env = process.env } = {}) {
  const rutas = []
  const repos = []
  const sumar = (config) => {
    if (typeof config?.path === 'string' && config.path) rutas.push(config.path)
    if (typeof config?.repo === 'string' && config.repo) repos.push(config.repo)
  }
  sumar(leerJson(path.join(raizProyecto, '.claude', 'vault.local.json')))
  if (env.VAULT_PATH) rutas.push(env.VAULT_PATH)
  const home = env.SOUCLAUDE_CLAUDE_HOME ?? path.join(os.homedir(), '.claude')
  sumar(leerJson(path.join(home, 'souclaude', 'vault.json')))
  return { rutas, repos }
}

export function rutasDelVault(opciones) {
  return configDelVault(opciones).rutas
}

// Dos rutas apuntan a la misma carpeta: por realpath (resuelve enlaces, nombres
// 8.3 y la forma de las barras) y sin distinguir mayusculas en Windows.
export function mismaCarpeta(a, b, plataforma = process.platform) {
  const canon = (ruta) => {
    let r
    try {
      r = fs.realpathSync.native(ruta)
    } catch {
      r = path.resolve(ruta)
    }
    r = r.replace(/[\\/]+$/, '')
    return plataforma === 'win32' ? r.replace(/\\/g, '/').toLowerCase() : r
  }
  return canon(a) === canon(b)
}

function salidaDe(r) {
  return r.status === 0 ? r.stdout.trim() : ''
}

// Ramas remotas concretas que tocaria el push: resuelve los comodines de
// destinosDelPush con git en la carpeta del push. Si git no responde (la
// carpeta no existe, no es un repo), se queda con lo explicito: ese push
// fallaria igual.
function ramasDestino(push, correr) {
  const ramas = new Set()
  const git = (args) => salidaDe(correr('git', args, { cwd: push.dir, timeout: 10_000 }))
  let actual = null
  const ramaActual = () => (actual ??= git(['rev-parse', '--abbrev-ref', 'HEAD']))
  for (const destino of push.destinos) {
    if (destino === TODAS) {
      // --all/--mirror suben main si existe en local; si git no responde, se asume que si.
      const r = correr('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${RAMA_PROTEGIDA}`], { cwd: push.dir, timeout: 10_000 })
      if (r.status === 0 || r.status == null) ramas.add(RAMA_PROTEGIDA)
    } else if (destino === RAMA_ACTUAL) {
      const rama = ramaActual()
      if (rama && rama !== 'HEAD') ramas.add(rama)
    } else if (destino === UPSTREAM) {
      const rama = ramaActual()
      const merge = rama && rama !== 'HEAD' ? git(['config', '--get', `branch.${rama}.merge`]) : ''
      if (merge) ramas.add(ramaCorta(merge))
    } else {
      ramas.add(destino)
    }
  }
  return ramas
}

// El repo del Vault de la organizacion (templates/harness.manifest.json ->
// vault.repo): cualquier clon del Vault se reconoce por el nombre de su remoto,
// tenga o no vault.local.json esta maquina.
const REPO_DEL_VAULT = /\/soubunker-vault$/

// `https://github.com/org/repo.git`, `git@github.com:org/repo.git` y
// `ssh://git@github.com/org/repo` -> `github.com/org/repo`; `C:\clones\repo` ->
// `c:/clones/repo`. Lo que vuelve comparables dos formas de nombrar un repo.
export function repoCanonico(url) {
  return String(url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^/@]+@/, '')
    .replace(/^([^/:]+):(?![\\/])/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

// URL del remoto al que va el push: el nombrado en el comando (o una URL o ruta
// escrita directo) o, sin nombrar, origin.
function urlDelRemoto(push, correr) {
  const remoto = push.remoto ?? 'origin'
  if (/[/\\:]/.test(remoto)) return remoto
  return salidaDe(correr('git', ['remote', 'get-url', remoto], { cwd: push.dir, timeout: 10_000 })) || null
}

// El push va al Vault si su carpeta (o la raiz de su repo) es una ruta
// configurada del Vault, si el repo tiene 00-System/ (la senal con la que el CLI
// reconoce un Vault) o si su remoto es el repo del Vault: el de la organizacion
// o uno declarado en la config. Asi un clon del Vault se reconoce aunque esta
// maquina no tenga vault.local.json, en modo equipo y en modo solo.
function esElVault({ push, raiz, correr, vault }) {
  const carpetas = raiz ? [push.dir, raiz] : [push.dir]
  if (carpetas.some((c) => vault.rutas.some((v) => mismaCarpeta(c, v)))) return true
  if (raiz && fs.existsSync(path.join(raiz, '00-System'))) return true
  const url = urlDelRemoto(push, correr)
  if (!url) return false
  const canon = repoCanonico(url)
  return REPO_DEL_VAULT.test(canon) || vault.repos.some((r) => repoCanonico(r) === canon)
}

// Decision `ask` del PreToolUse: el hook no puede afirmar que el comando viola
// una regla, pero tampoco que no. Decide el usuario, con el motivo a la vista.
function preguntar(lineas) {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: lineas.join('\n') },
  }
}

export function prePushMain({ push, correr, vault, enSolo = enModoSolo }) {
  const raiz = raizDelRepo(push.dir, correr)
  if (raiz && enSolo(raiz)) return null
  const tocaMain = ramasDestino(push, correr).has(RAMA_PROTEGIDA)
  if (!tocaMain && !push.incierto) return null
  // El Vault exime solo si la carpeta se pudo leer del comando. Si no (`cd "$X"
  // && git push ...`), que la carpeta evaluada sea el Vault no alcanza: un `main`
  // escrito en el comando se deniega igual, y lo demas se pregunta.
  const enElVault = esElVault({ push, raiz, correr, vault })
  if (enElVault && !push.dudaDeCarpeta) return null
  if (!tocaMain || (enElVault && !push.destinos.includes(RAMA_PROTEGIDA))) {
    return preguntar([
      `reglas-pr (SHS-M42): no se puede saber a que rama sube este push en ${raiz ?? push.dir}: ${push.incierto}.`,
      `\`${RAMA_PROTEGIDA}\` del proyecto solo recibe merges desde \`dev\` por PR. Confirma con el usuario que este push no la toca,`,
      push.dudaDeCarpeta
        ? 'o vuelve a escribirlo con la carpeta, el remoto y la rama literales (`cd <ruta> && git push origin <rama>`) para que no haga falta preguntar.'
        : 'o vuelve a escribirlo con el remoto y la rama literales (`git push origin <rama>`) para que no haga falta preguntar.',
    ])
  }
  const sobreElVault = vault.rutas.length
    ? `El Vault de esta maquina esta en ${vault.rutas[0]} y este push no apunta ahi. En el Vault el push directo a main es el protocolo y este hook lo deja pasar.`
    : 'No hay Vault configurado en esta maquina (.claude/vault.local.json, VAULT_PATH o ~/.claude/souclaude/vault.json); un clon del Vault se reconoce igual por su remoto (soubunker-vault) o por su carpeta 00-System. Si este push era al Vault y no se reconocio, configuralo: `souclaude upgrade --vault-path <ruta>`.'
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: [
        `reglas-pr (SHS-M42): push a \`${RAMA_PROTEGIDA}\` denegado en ${raiz ?? push.dir}.`,
        '`main` del proyecto solo recibe merges desde `dev` por PR: trabaja en la rama del milestone (`tipo/M<n>-slug`, desde `dev`) y pushea esa rama.',
        ...(push.dudaDeCarpeta ? [`Del comando ${push.dudaDeCarpeta}; se evaluo en ${push.dir}. Si el push era para otro repo, entra a su carpeta con una ruta literal (\`cd <ruta> && git push ...\`).`] : []),
        ...(enElVault ? [] : [sobreElVault]),
        'Para escribir en el Vault usa `souclaude vault-sync --push -m "<mensaje>" --paths Project-<PREFIJO>`, que corre sin confirmacion. No intentes rodear este hook.',
      ].join('\n'),
    },
  }
}

// Un push forzado reescribe historia que otros ya tienen. En modo equipo el
// protocolo lo prohibe (solo --force-with-lease, y solo sobre una rama propia):
// se pregunta siempre, en el proyecto y en el Vault. En modo solo no hay gates.
export function prePushForzado({ push, correr, enSolo = enModoSolo }) {
  if (!push.forzado) return null
  const raiz = raizDelRepo(push.dir, correr)
  if (raiz && enSolo(raiz)) return null
  return preguntar([
    `reglas-pr: push forzado (\`${push.forzado}\`) en ${raiz ?? push.dir}.`,
    'El protocolo es "nunca `git push --force`": solo `--force-with-lease`, solo sobre una rama propia y nunca sobre `dev` ni `main`.',
    'Confirma con el usuario antes de seguir; si era para sincronizar la rama, usa `git fetch origin && git merge origin/dev`.',
  ])
}

// `dev` es la rama de integracion: todas las ramas de trabajo nacen de ella y
// todos los PR apuntan a ella. Borrarla en el remoto (`git push origin --delete
// dev`, `git push origin :dev`) casa con la regla allow de `git push` y no la
// frenaba nada. No es un deny -- puede ser a proposito --, pero se pregunta.
// (`main` no llega aca: borrarla ya es "tocar main" y se deniega arriba.)
const RAMA_DE_INTEGRACION = 'dev'

export function prePushBorrado({ push, correr, vault, enSolo = enModoSolo }) {
  if (!push.borra?.includes(RAMA_DE_INTEGRACION)) return null
  const raiz = raizDelRepo(push.dir, correr)
  if (raiz && enSolo(raiz)) return null
  if (!push.dudaDeCarpeta && esElVault({ push, raiz, correr, vault })) return null
  return preguntar([
    `reglas-pr: este push BORRA la rama \`${RAMA_DE_INTEGRACION}\` del remoto en ${raiz ?? push.dir}.`,
    `\`${RAMA_DE_INTEGRACION}\` es la rama de integracion: de ella nacen las ramas de trabajo y a ella apuntan los PR.`,
    'Confirma con el usuario antes de seguir; para borrar una rama de trabajo ya mergeada, nombra esa rama.',
  ])
}

export function prePush({ push, raiz, correr }) {
  for (const cabeza of push.cabezas) {
    const args = [SCRIPT_CONFIABLE, '--grupo', 'secretos', '--sin-pushear']
    // Con "=": una ref que empiece con "-" no puede leerse como otra opcion.
    if (cabeza !== 'HEAD') args.push(`--cabeza=${cabeza}`)
    const r = correr(process.execPath, args, { cwd: raiz, timeout: 30_000 })
    const fail = (r.stdout ?? '').split('\n').find((l) => l.startsWith('[FAIL] sin-secretos'))
    if (r.status === 1 && fail) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: [
            'reglas-pr (SHS-M39): el push subiria archivos de credenciales.',
            fail,
            'No pushees. Si estan solo en commits que todavia no se pushearon, sacalos de ahi:',
            '`git reset --soft <upstream de la rama, u origin/dev si nunca se pusheo>`, `git rm --cached <archivo>`,',
            'sumalo a .gitignore y vuelve a commitear. Si alguno ya se habia pusheado antes, la credencial quedo',
            'expuesta: avisa al usuario para que la rote. Si es un falso positivo (un fixture sin credenciales),',
            'avisa al usuario: ese push lo hace el. No intentes rodear este hook.',
          ].join('\n'),
        },
      }
    }
    if (r.status !== 0) {
      return { systemMessage: `reglas-pr: no se pudo validar secretos antes del push (${primeraLinea(r)}); el push sigue sin validar.` }
    }
  }
  return null
}

// --- Frescura de docs/metodologia (SHS-M16) ----------------------------------
//
// La carpeta publicable de la metodologia lleva secciones generadas desde
// package.json y el manifest; un push con esas secciones desactualizadas
// publicaria documentacion vieja. Solo aplica al repo del generador: el script
// no se distribuye a consumidores ni va en el paquete publicado, asi que en
// cualquier otro repo este paso es un no-op. Igual que SCRIPT_CONFIABLE, se
// ejecuta siempre el script del proyecto del hook, nunca el del repo destino.
const SCRIPT_DOCS = path.join(RAIZ_DEL_HOOK, 'scripts', 'gen-docs-metodologia.mjs')

export function preDocsMetodologia(correr, { script = SCRIPT_DOCS, raizPush = RAIZ_DEL_HOOK, raizHook = RAIZ_DEL_HOOK } = {}) {
  if (!raizPush || !mismaCarpeta(raizPush, raizHook)) return null
  if (!fs.existsSync(script)) return null
  const r = correr(process.execPath, [script, '--check'], { cwd: raizHook, timeout: 30_000 })
  if (r.status === 1) {
    const fails = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('[FAIL]'))
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          'reglas-pr (SHS-M16): docs/metodologia esta desactualizada respecto del instalador y este push publicaria documentacion vieja.',
          ...(fails.length ? fails : ['[FAIL] docs-metodologia: drift en las secciones generadas']),
          'Corre `node scripts/gen-docs-metodologia.mjs`, revisa la prosa si el cambio lo amerita, commitea y vuelve a pushear. No intentes rodear este hook.',
        ].join('\n'),
      },
    }
  }
  if (r.status !== 0) {
    return { systemMessage: `reglas-pr: no se pudo verificar la frescura de docs/metodologia (${primeraLinea(r)}); el push sigue sin validar.` }
  }
  return null
}

function estadoDe(r) {
  // Un [AVISO] no cambia el resultado del grupo, pero se nota en la tabla.
  if (r.status === 0) return /^\[AVISO\]/m.test(r.salida ?? '') ? 'OK, con avisos' : 'OK'
  if (r.status === 1) return 'FAIL'
  return 'ERROR (no se pudo verificar)'
}

export function comentario({ sha, resultados }) {
  let salida = resultados.map((r) => `== ${r.grupo}\n${r.salida}`).join('\n\n')
  if (salida.length > LIMITE_SALIDA) salida = `${salida.slice(0, LIMITE_SALIDA)}\n... (recortado)`
  return [
    MARCA,
    '### Reglas de PR — corridas en la sesión del agente',
    '',
    `Checks corridos por el hook \`reglas-pr\` de Claude Code (SHS-M39) sobre \`${sha ? sha.slice(0, 7) : '?'}\`, en la sesión del agente. Los workflows \`reglas-*\` de GitHub Actions validan el mismo PR en CI.`,
    '',
    '| Grupo | Resultado |',
    '|---|---|',
    ...resultados.map((r) => `| ${r.grupo}${r.bloqueante ? '' : ' (informativo)'} | ${estadoDe(r)} |`),
    '',
    '<details><summary>Salida de <code>scripts/check-pr-rules.mjs</code></summary>',
    '',
    '````text',
    salida,
    '````',
    '',
    '</details>',
  ].join('\n')
}

// Lo que vuelve al agente: corto, solo lo que no dio OK, y que hacer.
export function textoParaElAgente({ url, sha, resultados, errorComentario }) {
  const lineas = [`reglas-pr (SHS-M39) · PR ${url}${sha ? ` · cabeza ${sha.slice(0, 7)}` : ''}`]
  for (const r of resultados) lineas.push(`- ${r.grupo}${r.bloqueante ? '' : ' (informativo)'}: ${estadoDe(r)}`)
  const avisos = resultados.flatMap((r) =>
    r.salida
      .split('\n')
      .filter((l) => /^\[(FAIL|skip|ERROR|AVISO)/.test(l))
      .map((l) => `  ${r.grupo} ${l}`),
  )
  if (avisos.length) {
    lineas.push('Detalle:', ...avisos.slice(0, MAX_AVISOS))
    if (avisos.length > MAX_AVISOS) lineas.push(`  ... y ${avisos.length - MAX_AVISOS} mas en el comentario del PR`)
  }
  lineas.push(
    errorComentario
      ? `No se pudo publicar el comentario en el PR (${errorComentario}): avisale al usuario.`
      : 'Resultado publicado como comentario en el PR.',
  )

  const fallaBloqueante = resultados.some((r) => r.bloqueante && r.status === 1)
  const sinVerificar = resultados.some((r) => r.status !== 0 && r.status !== 1)
  if (fallaBloqueante) {
    lineas.push(
      'Hay FAIL en un grupo bloqueante: corrigelo ahora, el PR no esta listo hasta que no quede ninguno.',
      `- Body: \`gh pr edit ${url} --body-file <archivo>\` (vuelve a disparar este check).`,
      `- Base: \`gh pr edit ${url} --base dev\`.`,
      `- Conflictos: \`git fetch origin && git merge origin/dev\`, push, y despues \`node .claude/hooks/reglas-pr.mjs --pr ${url}\`.`,
      '- Secreto: sacalo en un commit nuevo (`git rm --cached`) y avisa al usuario: ya se pusheo, hay que rotarlo.',
      'Si el FAIL no se arregla desde el body o la base, o sigue tras dos rondas, para y reportalo al usuario.',
    )
  }
  if (sinVerificar) {
    lineas.push(
      `Algun grupo no se pudo verificar (ERROR): cuando se resuelva, corre \`node .claude/hooks/reglas-pr.mjs --pr ${url}\`; si no se resuelve, avisale al usuario que el PR quedo sin validar.`,
    )
  }
  if (avisos.some((l) => l.includes('[AVISO]'))) {
    lineas.push('Los [AVISO] no bloquean, pero revisalos: si es una credencial real, sacala en un commit nuevo y avisa al usuario para rotarla.')
  }
  if (!fallaBloqueante && !sinVerificar) lineas.push('Los grupos bloqueantes pasaron. rama-commits es informativo: no reescribas commits ya pusheados.')
  return { estado: fallaBloqueante ? 'fail' : sinVerificar ? 'error' : 'ok', texto: lineas.join('\n') }
}

export function postPR({ objetivo, raiz, correr }) {
  const vista = correr('gh', ['pr', 'view', ...(objetivo ? [objetivo] : []), '--json', 'url,headRefOid'], { cwd: raiz, timeout: 20_000 })
  let pr = null
  try {
    if (vista.status === 0) pr = JSON.parse(vista.stdout)
  } catch {
    pr = null
  }
  if (!pr?.url) {
    const detalle = vista.status === 0 ? 'respuesta inesperada de gh' : primeraLinea(vista)
    return {
      estado: 'error',
      url: objetivo,
      texto: `reglas-pr (SHS-M39): no se pudo leer el PR con gh (${detalle}), asi que no se verifico. Cuando se resuelva, corre \`node .claude/hooks/reglas-pr.mjs --pr <url del PR>\`; si no, avisale al usuario que el PR quedo sin validar.`,
    }
  }

  // Para que la cabeza del PR (headRefOid) exista en local. Si falla (sin red),
  // el script reporta skip en lo que la necesita.
  correr('git', ['fetch', 'origin', '--quiet'], { cwd: raiz, timeout: 30_000 })

  const resultados = GRUPOS.map(({ grupo, bloqueante }) => {
    const r = correr(process.execPath, [SCRIPT_CONFIABLE, '--grupo', grupo, '--pr', pr.url], { cwd: raiz, timeout: 45_000 })
    const salida = (r.stdout ?? '').trim() || `[ERROR] ${primeraLinea(r)}`
    return { grupo, bloqueante, status: r.status === 0 || r.status === 1 ? r.status : 2, salida }
  })

  const publicado = correr('gh', ['pr', 'comment', pr.url, '--body-file', '-'], {
    cwd: raiz,
    timeout: 20_000,
    input: comentario({ sha: pr.headRefOid, resultados }),
  })
  const { estado, texto } = textoParaElAgente({
    url: pr.url,
    sha: pr.headRefOid,
    resultados,
    errorComentario: publicado.status === 0 ? null : primeraLinea(publicado),
  })
  return { estado, url: pr.url, texto }
}

// El modo manual corre sin prompt (regla allow): solo comenta en PRs del repo
// propio, no en cualquier PR donde el token de gh pueda escribir.
function repoDelOrigen(raiz, correr) {
  const r = correr('git', ['remote', 'get-url', 'origin'], { cwd: raiz, timeout: 10_000 })
  const m = r.status === 0 && r.stdout.trim().match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)
  return m ? m[1].toLowerCase() : null
}

export function prDeEsteRepo(objetivo, repoOrigen) {
  const m = String(objetivo ?? '').match(/^https:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/)
  if (!m) return !/^https?:/.test(String(objetivo ?? '')) // numero o rama: gh lo resuelve en este repo
  return repoOrigen != null && m[1].toLowerCase() === repoOrigen
}

export function salidaPostToolUse({ estado, texto, url }) {
  const hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext: texto }
  if (estado !== 'fail') return { hookSpecificOutput }
  // block + reason no esta confirmado en la doc de PostToolUse; el detalle
  // completo va igual en additionalContext, que si lo esta.
  return {
    decision: 'block',
    reason: `reglas-pr: FAIL bloqueante en el PR ${url}. El detalle y como corregirlo van en el contexto adicional.`,
    hookSpecificOutput,
  }
}

// Punto de entrada del hook: decide que hacer con la entrada de Claude Code.
export function procesar(entrada, correr = correrReal) {
  const comando = entrada?.tool_input?.command
  if (typeof comando !== 'string') return null
  const cwd = entrada.cwd || process.cwd()
  const shell = /powershell/i.test(entrada.tool_name ?? '') ? 'powershell' : 'bash'

  if (entrada.hook_event_name === 'PreToolUse') {
    // Primero main: es la regla dura y no necesita el script. Despues secretos.
    const esDeny = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny'
    const vault = configDelVault()
    // Un deny corta; una pregunta (`ask`) queda pendiente por si mas abajo hay
    // un deny, que siempre gana.
    let pregunta = null
    for (const push of destinosDelPush(comando, cwd, shell)) {
      const decision = prePushMain({ push, correr, vault }) ?? prePushForzado({ push, correr }) ?? prePushBorrado({ push, correr, vault })
      if (esDeny(decision)) return decision
      pregunta ??= decision
    }
    const push = pushDelComando(comando, cwd, shell)
    const raiz = push && repoConReglas(push.dir, correr, { tambienEnSolo: true })
    if (!raiz) return pregunta
    // Secretos primero; con eso en orden, la frescura de docs/metodologia
    // (solo en el repo del generador, SHS-M16). Un aviso de "no se pudo validar"
    // viaja junto con la pregunta, si la hay.
    const validacion = prePush({ push, raiz, correr }) ?? preDocsMetodologia(correr, { raizPush: raiz })
    if (esDeny(validacion) || !pregunta) return validacion
    return validacion?.systemMessage ? { ...pregunta, systemMessage: validacion.systemMessage } : pregunta
  }
  if (entrada.hook_event_name === 'PostToolUse') {
    const cambio = cambioDePR(comando, cwd, shell)
    const raiz = cambio && repoConReglas(cambio.dir, correr)
    if (!raiz) return null
    const url = urlDelPR(JSON.stringify(entrada.tool_response ?? entrada.tool_result ?? ''))
    return salidaPostToolUse(postPR({ objetivo: url ?? cambio.objetivo, raiz, correr }))
  }
  return null
}

function leerEntrada() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function main() {
  const indicePr = process.argv.indexOf('--pr')
  if (indicePr !== -1) {
    // Modo manual: node .claude/hooks/reglas-pr.mjs --pr <url>
    const raiz = repoConReglas(process.cwd(), correrReal)
    if (!raiz) {
      console.log('reglas-pr: este repo no tiene scripts/check-pr-rules.mjs del harness (o esta en modo solo).')
      process.exit(2)
    }
    const objetivo = process.argv[indicePr + 1] ?? null
    if (!prDeEsteRepo(objetivo, repoDelOrigen(raiz, correrReal))) {
      console.log(`reglas-pr: ${objetivo} no es un PR de este repo (origin); no se corre ni se comenta.`)
      process.exit(2)
    }
    const { estado, texto } = postPR({ objetivo, raiz, correr: correrReal })
    console.log(texto)
    process.exit(estado === 'ok' ? 0 : estado === 'fail' ? 1 : 2)
  }
  if (process.stdin.isTTY) {
    console.log('Uso: lo invoca Claude Code (JSON por stdin), o a mano: node .claude/hooks/reglas-pr.mjs --pr <url>')
    process.exit(0)
  }
  let salida = null
  try {
    salida = procesar(leerEntrada())
  } catch (e) {
    salida = { systemMessage: `reglas-pr: error interno del hook (${String(e?.message ?? e).split('\n')[0]}); no se verifico nada.` }
  }
  if (salida) process.stdout.write(JSON.stringify(salida))
  process.exit(0)
}

// Este archivo es el script que se esta ejecutando (y no un import desde los
// tests)? Se comparan rutas REALES: Node resuelve los enlaces simbolicos del
// script de entrada, asi que import.meta.url y process.argv[1] difieren cuando
// el proyecto se abre por una ruta con un enlace (un symlink o junction en el
// camino, /tmp y /var en macOS). Comparados tal cual, el hook terminaba sin
// hacer nada y con exit 0: la proteccion de main y el check de secretos
// quedaban apagados en silencio.
export function esPuntoDeEntrada(urlDelModulo, argv1 = process.argv[1], plataforma = process.platform) {
  if (!argv1) return false
  const real = (ruta) => {
    try {
      return fs.realpathSync.native(ruta)
    } catch {
      return path.resolve(ruta)
    }
  }
  const [modulo, entrada] = [real(fileURLToPath(urlDelModulo)), real(argv1)]
  return plataforma === 'win32' ? modulo.toLowerCase() === entrada.toLowerCase() : modulo === entrada
}

if (esPuntoDeEntrada(import.meta.url)) {
  main()
}
