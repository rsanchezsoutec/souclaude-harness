import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  segmentos,
  piezasDe,
  palabras,
  comandoEfectivo,
  comandoAnidado,
  pushForzado,
  pushLanzado,
  destinosDelPush,
  pushDelComando,
  cambioDePR,
  comentario,
  textoParaElAgente,
} from '../templates/base/claude/hooks/reglas-pr.mjs'

// El hook reglas-pr solo reconocia `git push` como PRIMERA palabra de un
// segmento. Cualquier otra forma de escribir el mismo push pasaba sin que lo
// viera -- y varias pasaban tambien sin pregunta, porque Claude Code quita
// `command`, `time`, `nohup`... antes de comparar con la regla allow
// `Bash(git push:*)`. Estos tests fijan tres cosas:
//   - lo que se puede leer del texto y toca main se DENIEGA igual, venga como venga;
//   - lo que el shell resuelve recien al ejecutar se PREGUNTA (no se adivina);
//   - el push forzado se PREGUNTA en modo equipo aunque el flag no vaya primero.
// Y, del otro lado, que nada de esto molesta al trabajo normal.
const HOOK = fileURLToPath(new URL('../templates/base/claude/hooks/reglas-pr.mjs', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../templates/base/scripts/check-pr-rules.mjs', import.meta.url))
const CWD = path.resolve('/repo')

// --- Lectura del comando -------------------------------------------------------

test('segmentos: los parentesis de un subshell o de una sustitucion separan, salvo entre comillas', () => {
  assert.deepEqual(segmentos('(git push origin main)'), ['git push origin main'])
  assert.deepEqual(segmentos('echo $(git push origin main)'), ['echo $', 'git push origin main'])
  assert.deepEqual(segmentos('git commit -m "fix (ver #12)" && git push'), ['git commit -m "fix (ver #12)"', 'git push'])
  assert.deepEqual(segmentos("echo '(git push)'"), ["echo '(git push)'"])
})

test('comandoEfectivo: quita envoltorios, palabras de control y agrupaciones pegadas', () => {
  const efectivo = (...p) => comandoEfectivo(p).p
  assert.deepEqual(efectivo('git', 'push'), ['git', 'push'])
  for (const envoltorio of ['command', 'builtin', 'exec', 'time', 'nohup', 'noglob', 'env', 'sudo']) {
    assert.deepEqual(efectivo(envoltorio, 'git', 'push'), ['git', 'push'], envoltorio)
  }
  assert.deepEqual(efectivo('env', 'GIT_TRACE=1', 'LANG=C', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('timeout', '30s', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('timeout', '--kill-after=5', '30', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('nice', '-n', '10', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('stdbuf', '-oL', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('/usr/bin/env', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('nohup', 'time', 'command', 'git', 'push'), ['git', 'push'], 'envoltorios encadenados')
  assert.deepEqual(efectivo('then', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('!', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('{', 'git', 'push'), ['git', 'push'])
  assert.deepEqual(efectivo('`git', 'push', 'origin', 'main`'), ['git', 'push', 'origin', 'main'])
  assert.deepEqual(efectivo('{git', 'push', 'origin', 'main}'), ['git', 'push', 'origin', 'main'])
  // xargs: el comando se ve, pero sus argumentos llegan por stdin.
  assert.deepEqual(comandoEfectivo(['xargs', '-n1', 'git', 'push', 'origin']), { p: ['git', 'push', 'origin'], viaXargs: true, envoltorios: ['xargs'] })
  // Lo que no es un envoltorio no se toca: `echo git push` no ejecuta ningun push.
  assert.deepEqual(efectivo('echo', 'git', 'push'), ['echo', 'git', 'push'])
  assert.deepEqual(efectivo('git', 'push', 'origin', '@{u}'), ['git', 'push', 'origin', '@{u}'], 'las llaves de un refspec no son agrupacion')
  assert.deepEqual(efectivo(), [])
})

test('comandoAnidado: bash -c, eval, powershell -Command y cmd /c', () => {
  assert.deepEqual(comandoAnidado(['bash', '-c', 'git push origin main']), { comando: 'git push origin main', shell: 'bash' })
  assert.deepEqual(comandoAnidado(['/bin/sh', '-lc', 'cd x && git push', 'arg0']), { comando: 'cd x && git push', shell: 'bash' })
  assert.deepEqual(comandoAnidado(['zsh', '-ic', 'git push']), { comando: 'git push', shell: 'bash' })
  assert.deepEqual(comandoAnidado(['eval', 'git', 'push', 'origin', 'main']), { comando: 'git push origin main', shell: 'bash' })
  assert.deepEqual(comandoAnidado(['iex', 'git push origin main'], 'powershell'), { comando: 'git push origin main', shell: 'powershell' })
  assert.deepEqual(comandoAnidado(['pwsh', '-NoProfile', '-Command', 'git', 'push']), { comando: 'git push', shell: 'powershell' })
  assert.deepEqual(comandoAnidado(['powershell.exe', '-c', 'git push']), { comando: 'git push', shell: 'powershell' })
  assert.deepEqual(comandoAnidado(['cmd', '/c', 'git', 'push', 'origin', 'main']), { comando: 'git push origin main', shell: 'cmd' })
  // Sin comando en linea no hay nada que analizar.
  assert.equal(comandoAnidado(['bash', 'deploy.sh']), null)
  assert.equal(comandoAnidado(['bash', '-c']), null)
  assert.equal(comandoAnidado(['git', 'push']), null)
  assert.equal(comandoAnidado(['ssh', 'host', '-c', 'x']), null, 'ssh no es sh')
  assert.equal(comandoAnidado(['push', '-c', 'x']), null)
})

test('pushForzado: el flag en cualquier posicion, agrupado o como +refspec', () => {
  const forzado = (texto) => pushForzado(texto.split(' ').filter(Boolean))
  assert.equal(forzado('--force origin x'), '--force')
  assert.equal(forzado('origin x --force'), '--force')
  assert.equal(forzado('origin x -f'), '-f')
  assert.equal(forzado('-uf origin x'), '-uf')
  assert.equal(forzado('origin x --force-with-lease'), '--force-with-lease')
  assert.equal(forzado('origin x --force-with-lease=x:abc123'), '--force-with-lease=x:abc123')
  assert.equal(forzado('--force-if-includes origin x'), '--force-if-includes')
  assert.equal(forzado('origin +x'), '+x')
  assert.equal(forzado('origin +HEAD:refs/heads/x'), '+HEAD:refs/heads/x')
  // No son push forzado.
  for (const normal of ['origin x', '-u origin x', '--follow-tags origin x', '-o ci.skip origin x', '--push-option -f origin x', 'origin fix/a-f', '--no-verify -q origin x', '-n origin x', '']) {
    assert.equal(forzado(normal), null, normal)
  }
})

test('destinosDelPush: ve el push a traves de envoltorios, agrupaciones y comandos anidados', () => {
  const destinos = (comando, shell) => destinosDelPush(comando, CWD, shell).map((d) => d.destinos)
  for (const comando of [
    'command git push origin main',
    'env GIT_TRACE=1 git push origin main',
    'timeout 60 git push origin main',
    'nohup git push origin main &',
    '(git push origin main)',
    '{ git push origin main; }',
    'if true; then git push origin main; fi',
    'for r in a b; do git push origin main; done',
    '! git push origin main',
    'bash -c "git push origin main"',
    "sh -c 'cd sub && git push origin main'",
    'eval "git push origin main"',
    'echo x | xargs git push origin main',
    'echo $(git push origin main)',
    'x=`git push origin main`',
    'bash -c "bash -c \\"git push origin main\\""',
  ]) {
    assert.deepEqual(destinos(comando), [['main']], comando)
  }
  assert.deepEqual(destinos('iex "git push origin main"', 'powershell'), [['main']])
  assert.deepEqual(destinos('pwsh -Command "git push origin main"', 'powershell'), [['main']])
  assert.deepEqual(destinos('& { git push origin main }', 'powershell'), [['main']])
  // El cd de un comando anidado no cambia la carpeta de afuera, y el de afuera si aplica adentro.
  assert.equal(destinosDelPush('bash -c "cd otro && git push origin x"; git push origin y', CWD)[1].dir, CWD)
  assert.equal(destinosDelPush('cd sub && bash -c "git push origin x"', CWD)[0].dir, path.resolve(CWD, 'sub'))
  assert.equal(destinosDelPush('bash -c "cd sub && git push origin x"', CWD)[0].dir, path.resolve(CWD, 'sub'))
})

test('destinosDelPush: lo que el shell resuelve al ejecutar viaja como incierto, con el motivo', () => {
  const incierto = (comando, shell) => destinosDelPush(comando, CWD, shell)[0]?.incierto ?? null
  assert.match(incierto('git push origin $RAMA'), /\$RAMA/)
  assert.match(incierto('git push origin "${RAMA}"'), /RAMA/)
  assert.match(incierto('git push origin "$(cat rama.txt)"'), /cat rama\.txt/)
  assert.match(incierto('git push origin `cat rama.txt`'), /cat/)
  assert.match(incierto('git push $REMOTO fix/M1-x'), /\$REMOTO/)
  assert.match(incierto('git push origin "refs/heads/ma*:refs/heads/ma*"'), /ma\*/)
  assert.match(incierto('git push origin $env:RAMA', 'powershell'), /\$env:RAMA/)
  assert.match(incierto('git push origin %RAMA%'), /%RAMA%/)
  assert.match(incierto('echo main | xargs git push origin'), /xargs/)
  assert.match(incierto('git -c alias.p=push p origin main'), /alias/)
  // Una expresion entre parentesis completa los argumentos: el push queda sin
  // refspec a la vista, pero NO es "push de la rama actual".
  assert.match(incierto('git push origin (Get-Content rama.txt)', 'powershell'), /parentesis/)
  assert.match(incierto('git push origin @(Get-Content rama.txt)', 'powershell'), /parentesis/)
  assert.match(incierto('git push origin (Get-Content rama.txt) --force', 'powershell'), /parentesis/)
  assert.equal(incierto('(git push origin fix/M1-x)'), null, 'un subshell que envuelve al push entero no lo vuelve incierto')
  assert.equal(incierto('git push origin fix/M1-x && (cd otro && ls)'), null)
  // Lo literal no es incierto.
  for (const literal of ['git push', 'git push origin fix/M1-x', 'git push -u origin HEAD', 'git push origin HEAD:refs/heads/x', 'git push origin @{u}', 'git push origin v3.18.1', 'git -c user.name=x push origin x']) {
    assert.equal(incierto(literal), null, literal)
  }
})

test('destinosDelPush: `$(git branch --show-current)` es la rama actual, no algo incierto', () => {
  for (const comando of [
    'git push -u origin "$(git branch --show-current)"',
    'git push -u origin $(git branch --show-current)',
    'git push origin `git rev-parse --abbrev-ref HEAD`',
    'git push origin "$(git symbolic-ref --short HEAD)"',
  ]) {
    const [push] = destinosDelPush(comando, CWD)
    assert.equal(push.incierto, null, comando)
    assert.deepEqual(push.destinos, ['@rama-actual'], comando)
    assert.deepEqual(pushDelComando(comando, CWD).cabezas, ['HEAD'], comando)
  }
})

test('pushLanzado: abre las listas de PowerShell y los bloques; sin git o sin push no hay nada que leer', () => {
  assert.deepEqual(pushLanzado(['git', 'push', 'origin', 'main']), ['origin', 'main'])
  assert.deepEqual(pushLanzado(['git', '-ArgumentList', 'push,origin,main']), ['origin', 'main'])
  assert.deepEqual(pushLanzado(['-FilePath', 'git', '-ArgumentList', 'push origin main', '-Wait']), ['origin', 'main', '-Wait'])
  assert.deepEqual(pushLanzado(['-ArgumentList', 'push,origin,main', '-FilePath', 'C:\\Program Files\\Git\\cmd\\git.exe']), ['origin', 'main', '-FilePath'])
  assert.deepEqual(pushLanzado(['C:\\Program Files\\Git\\cmd\\git.exe push origin main']), ['origin', 'main'], 'el comando entero entre comillas')
  assert.deepEqual(pushLanzado(['-ScriptBlock', '{', 'git', 'push', 'origin', 'main', '}']), ['origin', 'main'])
  assert.deepEqual(pushLanzado(['{git', 'push', 'origin', 'main}']), ['origin', 'main'])
  assert.deepEqual(pushLanzado(['powershell', '-ArgumentList', '-Command git push origin main']), ['origin', 'main'], 'un lanzador que lanza un shell')
  assert.equal(pushLanzado(['git', '-ArgumentList', 'status']), null)
  assert.equal(pushLanzado(['notepad', 'git-push-notas.txt']), null)
  assert.equal(pushLanzado(['gh', 'pr', 'create']), null)
  assert.equal(pushLanzado([]), null)
})

test('destinosDelPush: lanzadores, `git send-pack` y el refspec `:` (matching) se leen como un push', () => {
  const destinos = (comando, shell) => destinosDelPush(comando, CWD, shell).map((d) => d.destinos)
  // `:` a secas sube todas las ramas que coinciden; no es "borrar la rama vacia".
  assert.deepEqual(destinos('git push origin :'), [['*']])
  assert.deepEqual(destinos('git push origin +:'), [['*']])
  assert.deepEqual(destinosDelPush('git push origin :', CWD)[0].borra, [], 'el refspec matching no borra nada')
  assert.deepEqual(pushDelComando('git push origin :', CWD).cabezas, ['--branches'], 'el check de secretos mira todas las ramas')
  assert.deepEqual(destinos('git push origin :vieja'), [['vieja']])
  assert.deepEqual(destinosDelPush('git push origin :vieja', CWD)[0].borra, ['vieja'])
  // send-pack: mismos argumentos que push, siempre marcado como incierto.
  assert.deepEqual(destinos('git send-pack origin main'), [['main']])
  assert.deepEqual(destinos('git send-pack --all origin'), [['*']])
  assert.match(destinosDelPush('git send-pack origin fix/M1-x', CWD)[0].incierto, /send-pack/)
  // Lanzadores: lo que se alcanza a leer, tambien marcado como incierto.
  assert.deepEqual(destinos('start git push origin main'), [['main']])
  assert.deepEqual(destinos('Start-Process git -ArgumentList "push","origin","main"', 'powershell'), [['main']])
  assert.deepEqual(destinos('Invoke-Command -ScriptBlock { git push origin main }', 'powershell'), [['main']])
  assert.match(destinosDelPush('saps git push,origin,x', CWD, 'powershell')[0].incierto, /saps/)
  assert.deepEqual(destinos('Start-Process git -ArgumentList status', 'powershell'), [])
  assert.deepEqual(destinos('start notepad git-push-notas.txt'), [])
})

test('cambioDePR: tambien ve `gh pr create` detras de un envoltorio', () => {
  assert.equal(cambioDePR('command gh pr create --fill', CWD)?.accion, 'create')
  assert.equal(cambioDePR('env GH_PAGER= gh pr edit 12 --body-file b.md', CWD)?.accion, 'edit')
  assert.equal(cambioDePR('echo gh pr create', CWD), null)
})

// --- La carpeta del push ---------------------------------------------------------
//
// El security review de esta rama encontro que, al mirar a traves de parentesis
// y envoltorios, el hook habia empezado a creerle a cualquier `cd`: `(cd
// <vault>); git push origin main` se atribuia al Vault -- que esta exento -- y
// pasaba, y con el `cd` a una carpeta sin reglas se salteaba el check de
// secretos. La carpeta la mueve solo el `cd` que llega a lo que viene despues.

test('piezasDe: cada pieza con el operador que la corto; en cmd un `&` separa como `;`', () => {
  const cortes = (comando, shell) => piezasDe(comando, shell).map((p) => [p.texto.trim(), p.corte])
  assert.deepEqual(cortes('cd x && git push | tee log; (ls) &'), [
    ['cd x', '&&'],
    ['git push', '|'],
    ['tee log', ';'],
    ['', '('],
    ['ls', ')'],
    ['', '&'],
    ['', ''],
  ])
  assert.deepEqual(cortes('x=`cat f` y'), [
    ['x=', '`('],
    ['cat f', '`)'],
    ['y', ''],
  ])
  assert.deepEqual(cortes('a |& b\nc'), [
    ['a', '|'],
    ['b', ';'],
    ['c', ''],
  ])
  assert.deepEqual(cortes('git push 2>&1 &> log'), [['git push 2>&1 &> log', '']])
  assert.deepEqual(cortes('cd x & git push', 'cmd'), [
    ['cd x', ';'],
    ['git push', ''],
  ])
  // En PowerShell el backtick escapa: ni corta ni deja cortar al caracter que sigue.
  assert.deepEqual(cortes('echo a`;b', 'powershell'), [['echo a`;b', '']])
  // Un comentario se descarta hasta el fin de la linea; un `#` dentro de una palabra no lo es.
  assert.deepEqual(cortes("echo a # it's\ngit push"), [
    ['echo a', ';'],
    ['', ';'],
    ['git push', ''],
  ])
  assert.deepEqual(cortes('echo a#b $# "# c" \\#d'), [['echo a#b $# "# c" \\#d', '']])
  assert.deepEqual(cortes('rem # x & git push', 'cmd'), [
    ['rem # x', ';'],
    ['git push', ''],
  ])
  // `desde` y `hasta` son la posicion de la pieza en el comando.
  const comando = 'git push origin $(cat "rama (vieja).txt") main'
  for (const pieza of piezasDe(comando)) assert.equal(comando.slice(pieza.desde, pieza.hasta), pieza.texto)
})

test('palabras: una expresion entre parentesis o backticks queda entera en su palabra', () => {
  assert.deepEqual(palabras('git push origin $(cat rama.txt) --force'), ['git', 'push', 'origin', '$(cat rama.txt)', '--force'])
  assert.deepEqual(palabras('git push `echo origin` main'), ['git', 'push', '`echo origin`', 'main'])
  assert.deepEqual(palabras('git push origin (Get-Content "rama actual.txt")', 'powershell'), ['git', 'push', 'origin', '(Get-Content rama actual.txt)'])
  // Una asignacion con una sustitucion es una sola palabra, y se descarta como cualquier otra.
  assert.deepEqual(palabras('X=`cat f` Y=$(pwd) git push origin main'), ['git', 'push', 'origin', 'main'])
})

test('carpeta del push: el `cd` de un subshell o de una sustitucion no sale de ella (bash)', () => {
  const dir = (comando, shell) => destinosDelPush(comando, CWD, shell).map((p) => p.dir)
  const otro = path.resolve(CWD, 'otro')
  for (const comando of [
    '(cd otro); git push origin x',
    '(cd otro) && git push origin x',
    '(cd otro && ls); git push origin x',
    'echo $(cd otro); git push origin x',
    'x=`cd otro`; git push origin x',
    'x=$(cd otro && pwd) && git push origin x',
    '((cd otro)); git push origin x',
  ]) {
    assert.deepEqual(dir(comando), [CWD], comando)
  }
  // Adentro si vale, y al salir vuelve la de antes.
  assert.deepEqual(dir('(cd otro && git push origin x); git push origin y'), [otro, CWD])
  assert.deepEqual(dir('cd otro && (cd sub && git push origin x) && git push origin y'), [path.resolve(otro, 'sub'), otro])
  // Las llaves agrupan en el mismo shell: ese cd queda.
  assert.deepEqual(dir('{ cd otro; git push origin x; }; git push origin y'), [otro, otro])
  // En PowerShell y en cmd un parentesis no abre otro proceso.
  assert.deepEqual(dir('(Set-Location otro); git push origin x', 'powershell'), [otro])
  assert.deepEqual(dir('cmd /c "(cd /d otro) & git push origin x"'), [otro])
})

test('carpeta del push: no la mueve el `cd` que corre en otro proceso', () => {
  const dir = (comando, shell) => destinosDelPush(comando, CWD, shell).map((p) => p.dir)
  const otro = path.resolve(CWD, 'otro')
  for (const comando of [
    'nohup cd otro; git push origin x',
    'env cd otro; git push origin x',
    'timeout 5 cd otro; git push origin x',
    'sudo cd otro; git push origin x',
    'exec cd otro; git push origin x',
    'cd otro | cat; git push origin x',
    'cd otro | git push origin x',
    'cd otro & git push origin x',
    'bash -c "cd otro"; git push origin x',
  ]) {
    assert.deepEqual(dir(comando), [CWD], comando)
  }
  // Los envoltorios del propio shell no cambian de proceso, y una redireccion no es una tuberia.
  for (const comando of [
    'command cd otro && git push origin x',
    'builtin cd otro; git push origin x',
    'time cd otro; git push origin x',
    'cd otro 2>/dev/null && git push origin x',
    'cd otro &>/dev/null; git push origin x',
    'if cd otro; then git push origin x; fi',
    'eval "cd otro"; git push origin x',
  ]) {
    assert.deepEqual(dir(comando), [otro], comando)
  }
  // PowerShell corre la tuberia en el mismo proceso; un trabajo aparte, no.
  assert.deepEqual(dir('cd otro | Out-Null; git push origin x', 'powershell'), [otro])
  assert.deepEqual(dir('Start-Job { cd otro }; git push origin x', 'powershell'), [CWD])
  // En cmd un `&` suelto no manda al fondo: separa. Una tuberia si es otro proceso.
  assert.deepEqual(dir('cmd /c "cd /d otro & git push origin x"'), [otro])
  assert.deepEqual(dir('cmd /c "cd /d otro | more & git push origin x"'), [CWD])
})

test('carpeta del push: `cd -`, `pushd`/`popd` y lo que sigue a `cd x ||`', () => {
  const dir = (comando, shell) => destinosDelPush(comando, CWD, shell).map((p) => p.dir)
  const a = path.resolve(CWD, 'a')
  assert.deepEqual(dir('cd a; cd -; git push origin x'), [CWD])
  assert.deepEqual(dir('cd a; cd -; cd -; git push origin x'), [a])
  assert.deepEqual(dir('pushd a; popd; git push origin x'), [CWD])
  assert.deepEqual(dir('pushd a && git push origin x && popd && git push origin y'), [a, CWD])
  assert.deepEqual(dir('pushd a; pushd b; popd; git push origin x'), [a])
  assert.deepEqual(dir('pushd a; pushd b; pushd; git push origin x'), [a], '`pushd` a secas intercambia con la ultima apilada')
  assert.deepEqual(dir('popd; git push origin x'), [CWD], 'sin nada apilado, popd no mueve nada')
  assert.deepEqual(dir('Push-Location a; git push origin x; Pop-Location; git push origin y', 'powershell'), [a, CWD])
  // Lo que sigue a `||` corre solo si el cd fallo: en la carpeta de antes.
  assert.deepEqual(dir('cd a || git push origin x'), [CWD])
  assert.deepEqual(dir('cd a || exit 1; git push origin x'), [a])
  assert.deepEqual(dir('cd a || { echo no; exit 1; }; git push origin x'), [a])
  assert.deepEqual(dir('cd a && git push origin x || echo fallo'), [a])
})

test('carpeta del push: cuando no se puede saber, viaja como duda', () => {
  const push = (comando, shell) => destinosDelPush(comando, CWD, shell)[0]
  for (const [comando, motivo] of [
    // El destino sale de una variable o de una sustitucion: la carpeta queda como estaba.
    ['cd "$DESTINO" && git push origin x', /\$DESTINO/],
    ['cd $(dirname "$0") && git push origin x', /dirname/],
    ['cd %DESTINO% && git push origin x', /%DESTINO%/],
    ['git -C "$DESTINO" push origin x', /git -C \$DESTINO/],
    ['pushd "$DESTINO"; git push origin x', /\$DESTINO/],
    // El ultimo comando de una tuberia corre en el shell actual en zsh y en un subshell en bash.
    ['true | cd otro; git push origin x', /tuberia/],
    // `cd -` sin un cd previo en el mismo comando, y una pila que no se ve.
    ['cd -; git push origin x', /cd -/],
    ['pushd +1; git push origin x', /pushd \+1/],
  ]) {
    const p = push(comando)
    assert.equal(p.dir, CWD, comando)
    assert.match(p.dudaDeCarpeta, motivo, comando)
    assert.match(p.incierto, /no se sabe en que carpeta corre/, comando)
  }
  // Un destino incierto del propio push se nombra primero; la duda de carpeta viaja igual.
  const dos = push('cd "$DESTINO" && git push origin $RAMA')
  assert.match(dos.incierto, /\$RAMA/)
  assert.match(dos.dudaDeCarpeta, /\$DESTINO/)
  // Sin refspec sigue siendo la rama actual de la carpeta evaluada.
  assert.deepEqual(push('cd "$DESTINO" && git push').destinos, ['@rama-actual', '@upstream'])
  // Una ruta absoluta despues vuelve a dejarla en claro.
  const otroRepo = path.resolve('/otro repo')
  const claro = push(`cd "$DESTINO"; cd "${otroRepo}" && git push origin x`)
  assert.equal(claro.dir, otroRepo)
  assert.equal(claro.dudaDeCarpeta, null)
  assert.equal(claro.incierto, null)
  // Lo literal no deja dudas.
  for (const comando of ['cd otro && git push origin x', 'git -C otro push origin x', '(cd otro); git push origin x', 'cd otro; cd -; git push origin x']) {
    assert.equal(push(comando).dudaDeCarpeta, null, comando)
  }
})

test('carpeta del push: `~`, `$HOME`, `$PWD` y la raiz del repo actual si se resuelven', () => {
  const push = (comando, shell) => destinosDelPush(comando, CWD, shell)[0]
  const enCasa = path.join(os.homedir(), 'vault')
  for (const comando of ['cd ~/vault && git push origin x', 'cd "$HOME/vault" && git push origin x', 'cd "${HOME}/vault" && git push origin x', 'git -C "$HOME/vault" push origin x']) {
    assert.equal(push(comando).dir, enCasa, comando)
    assert.equal(push(comando).dudaDeCarpeta, null, comando)
  }
  assert.equal(push('cd $env:USERPROFILE/vault; git push origin x', 'powershell').dir, enCasa)
  assert.equal(push('git -C "$PWD" push origin x').dir, CWD)
  assert.equal(push('cd "$(pwd)/sub" && git push origin x').dir, path.resolve(CWD, 'sub'))
  assert.equal(push('cd otro && git -C "$PWD/sub" push origin x').dir, path.resolve(CWD, 'otro', 'sub'))
  // `cd "$(git rev-parse --show-toplevel)"` es quedarse en el mismo repo.
  for (const comando of [
    'cd "$(git rev-parse --show-toplevel)" && git push',
    'cd $(git rev-parse --show-toplevel) && git push',
    'cd `git rev-parse --show-toplevel` && git push',
    'git -C "$(git rev-parse --show-toplevel)" push',
  ]) {
    const p = push(comando)
    assert.equal(p.dir, CWD, comando)
    assert.equal(p.dudaDeCarpeta, null, comando)
    assert.equal(p.incierto, null, comando)
  }
})

test('destinosDelPush: un comando cortado por una expresion se lee entero', () => {
  const push = (comando, shell) => destinosDelPush(comando, CWD, shell)[0]
  const destinos = (comando, shell) => destinosDelPush(comando, CWD, shell).map((p) => p.destinos)
  // El remoto sale de una expresion, pero `main` esta escrito en el comando.
  assert.deepEqual(destinos('git push $(echo origin) main'), [['main']])
  assert.deepEqual(destinos('git push `echo origin` main'), [['main']])
  assert.deepEqual(destinos('command git push $(echo origin) HEAD:main'), [['main']])
  assert.deepEqual(destinos('git push (Get-Remoto) main', 'powershell'), [['main']])
  assert.deepEqual(destinos('git push origin (Get-Content rama.txt) main', 'powershell'), [['(Get-Content rama.txt)', 'main']])
  // El flag que viene despues de la expresion tambien se ve.
  assert.equal(push('git push origin (Get-Content rama.txt) --force', 'powershell').forzado, '--force')
  assert.equal(push('git push origin $(cat rama.txt) --force').forzado, '--force')
  // El check de secretos revisa HEAD cuando el origen no se puede leer.
  assert.deepEqual(pushDelComando('git push origin $(cat rama.txt)', CWD).cabezas, ['HEAD'])
  assert.deepEqual(pushDelComando('git push origin "$RAMA"', CWD).cabezas, ['HEAD'])
  assert.deepEqual(pushDelComando('git push origin (Get-Content rama.txt)', CWD, 'powershell').cabezas, ['HEAD'])
  // Una asignacion con una sustitucion delante no esconde el push.
  for (const comando of ['X=`pwd` git push origin main', 'X=`cat f` git push origin main', 'X=$(cat f) git push origin main', 'X=`cat f` Y=2 command git push origin main']) {
    assert.deepEqual(destinos(comando), [['main']], comando)
  }
  // Los parentesis vacios de una definicion de funcion no son una expresion: su cuerpo se lee.
  assert.deepEqual(destinos('git() { command git push origin main; }; git status'), [['main']])
  assert.deepEqual(destinos('subir() { git push origin main; }; subir'), [['main']])
})

test('destinosDelPush: sin refspec sube la rama actual, aunque el remoto no se pueda leer', () => {
  const push = (comando) => destinosDelPush(comando, CWD)[0]
  assert.deepEqual(push('git push $REMOTO').destinos, ['@rama-actual', '@upstream'])
  assert.match(push('git push $REMOTO').incierto, /\$REMOTO/)
  assert.deepEqual(push('git push "$(cat remoto.txt)"').destinos, ['@rama-actual', '@upstream'])
  // Con xargs o un alias los argumentos llegan por otro lado: no se asume nada.
  assert.deepEqual(push('echo main | xargs git push origin').destinos, [])
  assert.deepEqual(push('git -c alias.p=push p origin').destinos, [])
})

test('destinosDelPush: un comentario no esconde el push que sigue, ni cuenta como push', () => {
  const destinos = (comando, shell) => destinosDelPush(comando, CWD, shell).map((p) => p.destinos)
  // El apostrofo de un comentario abria una comilla que se tragaba el resto del comando.
  assert.deepEqual(destinos("# Let's push the fix\ngit push origin main"), [['main']])
  assert.deepEqual(destinos("git fetch origin  # don't skip this\ngit push origin main"), [['main']])
  assert.deepEqual(destinos("# Let's push\ngit push origin main", 'powershell'), [['main']])
  // Nombrar un push en un comentario no es hacerlo.
  assert.deepEqual(destinos('git push origin fix/M1-x # no usar: git push origin main'), [['fix/M1-x']])
  assert.deepEqual(destinos('git push origin fix/M1-x  # sube la rama; git push origin main seria un error'), [['fix/M1-x']])
  assert.deepEqual(destinos('# git push origin main\ngit push origin fix/M1-x'), [['fix/M1-x']])
  // Un `#` que no empieza una palabra no es un comentario.
  for (const comando of ['echo a#b; git push origin main', 'echo a\\ #b; git push origin main', 'echo "# no"; git push origin main', 'echo $# ; git push origin main', 'x=${y#z}; git push origin main']) {
    assert.deepEqual(destinos(comando), [['main']], comando)
  }
  // En cmd el `#` no comenta nada.
  assert.deepEqual(destinos('cmd /c "echo # & git push origin main"'), [['main']])
})

test('lectura acotada: un comando enorme o mal cerrado no deja al hook sin su plazo', () => {
  // Un hook que se pasa de su plazo no frena nada. Releer los comandos cortados
  // y resolver una ruta que crece con cada `cd` costaban el cuadrado del largo:
  // con 20.000 repeticiones, medio minuto o mas; acotado, milisegundos.
  const N = 20_000
  for (const comando of [
    'git a $('.repeat(N) + 'x' + ')'.repeat(N) + '; git push origin main',
    'git status ('.repeat(N) + ' git push origin main',
    'cd a; '.repeat(N) + 'git push origin main',
    'pushd a; '.repeat(N) + 'git push origin main',
    '('.repeat(N) + 'git push origin main' + ')'.repeat(N),
  ]) {
    const inicio = Date.now()
    const pushes = destinosDelPush(comando, CWD)
    const tardo = Date.now() - inicio
    assert.ok(pushes.some((p) => p.destinos.includes('main')), `el push a main se dejo de ver en ${comando.slice(0, 24)}...`)
    assert.ok(tardo < 5000, `${tardo} ms para ${comando.length} caracteres (${comando.slice(0, 24)}...)`)
  }
  // Una expresion sin cerrar no se puede leer entera: cuenta como algo incierto.
  const sinCerrar = destinosDelPush('git push origin $(cat rama.txt', CWD)[0]
  assert.match(sinCerrar.incierto, /se resuelve recien al ejecutar/)
  assert.deepEqual(destinosDelPush('git push origin main $(cat rama.txt', CWD)[0].destinos.slice(0, 1), ['main'], 'lo escrito antes del corte se sigue leyendo')
  // Una ruta mas larga que cualquier ruta real no se sigue: queda como duda.
  const larga = destinosDelPush(`cd ${'a/'.repeat(3000)} && git push origin x`, CWD)[0]
  assert.equal(larga.dir, CWD)
  assert.match(larga.dudaDeCarpeta, /pasa de lo que este hook sigue/)
})

test('cambioDePR: la carpeta se lee igual que la del push', () => {
  assert.equal(cambioDePR('(cd otro); gh pr create --fill', CWD).dir, CWD)
  assert.equal(cambioDePR('cd otro && gh pr create --fill', CWD).dir, path.resolve(CWD, 'otro'))
  assert.equal(cambioDePR('nohup cd otro; gh pr edit 12 --body-file b.md', CWD).dir, CWD)
  assert.equal(cambioDePR('bash -c "cd otro && gh pr create --fill"', CWD).dir, path.resolve(CWD, 'otro'))
})

// --- El hook real, como lo corre Claude Code ------------------------------------

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// `conReglas`: con scripts/check-pr-rules.mjs, para que corra tambien el check de secretos.
function proyecto({ modo = null, rama = 'fix/M1-algo', conReglas = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souclaude evasion '))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: raiz')
  if (rama !== 'main') git(dir, 'switch', '-q', '-c', rama)
  git(dir, 'remote', 'add', 'origin', 'https://github.com/soutecdev/app-de-ejemplo.git')
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true })
  fs.copyFileSync(HOOK, path.join(dir, '.claude', 'hooks', 'reglas-pr.mjs'))
  if (conReglas) {
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-pr-rules.mjs'))
  }
  if (modo) fs.writeFileSync(path.join(dir, '.claude', 'harness.json'), JSON.stringify({ modo }))
  return dir
}

// Decision del hook: 'deny' | 'ask' | null (sin salida: el comando sigue su curso normal).
function decision(dir, comando, { cwd = dir, toolName = 'Bash', env = {} } = {}) {
  const salida = execFileSync(process.execPath, [path.join(dir, '.claude', 'hooks', 'reglas-pr.mjs')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, cwd, tool_input: { command: comando } }),
    encoding: 'utf8',
    env: { ...process.env, VAULT_PATH: '', SOUCLAUDE_CLAUDE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'souclaude home ')), ...env },
  })
  if (salida === '') return null
  const json = JSON.parse(salida)
  return { tipo: json.hookSpecificOutput.permissionDecision, motivo: json.hookSpecificOutput.permissionDecisionReason }
}

test('hook real: el push a main se deniega tambien envuelto, agrupado o anidado', () => {
  const dir = proyecto()
  for (const comando of [
    'command git push origin main',
    'time git push origin main',
    'nohup git push origin main',
    'env git push origin main',
    'timeout 60 git push origin main',
    '(git push origin main)',
    '{ git push origin main; }',
    'if true; then git push origin main; fi',
    '! git push origin main',
    'bash -c "git push origin main"',
    "sh -c 'git push origin HEAD:main'",
    'eval "git push origin dev:main"',
    'echo x | xargs git push origin main',
    'git fetch && (cd . && command git push origin main)',
  ]) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'deny', comando)
    assert.match(d.motivo, /SHS-M42/, comando)
  }
  assert.equal(decision(dir, 'iex "git push origin main"', { toolName: 'PowerShell' })?.tipo, 'deny')
  // Parado en main, la rama actual escrita como sustitucion tambien se resuelve y se deniega.
  const enMain = proyecto({ rama: 'main' })
  assert.equal(decision(enMain, 'command git push -u origin "$(git branch --show-current)"')?.tipo, 'deny')
})

test('hook real: si el destino no se puede leer del texto, pregunta en vez de dejarlo pasar', () => {
  const dir = proyecto()
  for (const comando of [
    'B=main; git push origin $B',
    'git push origin "$(echo main)"',
    'git push origin `echo main`',
    'git -c alias.p=push p origin main',
    'echo main | xargs git push origin',
    'git push origin "+refs/heads/ma*:refs/heads/ma*"',
  ]) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'ask', comando)
    assert.match(d.motivo, /no se puede saber a que rama sube este push/, comando)
  }
  assert.equal(decision(dir, 'git push origin $env:RAMA', { toolName: 'PowerShell' })?.tipo, 'ask')
  for (const comando of ['git push origin (Get-Content rama.txt)', 'git push origin @(Get-Content rama.txt)', 'git push origin (Get-Content rama.txt) --force']) {
    assert.equal(decision(dir, comando, { toolName: 'PowerShell' })?.tipo, 'ask', comando)
  }
})

test('hook real: el push forzado se pregunta en modo equipo, este donde este el flag', () => {
  const dir = proyecto()
  for (const comando of [
    'git push --force origin fix/M1-algo',
    'git push origin fix/M1-algo --force',
    'git push -u origin fix/M1-algo -f',
    'git push -uf origin fix/M1-algo',
    'git push origin +fix/M1-algo',
    'git push origin fix/M1-algo --force-with-lease',
    'command git push origin fix/M1-algo --force',
    'git push --tags --force',
  ]) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'ask', comando)
    assert.match(d.motivo, /push forzado/, comando)
  }
  // Forzado Y a main: gana el deny.
  assert.equal(decision(dir, 'git push origin main --force')?.tipo, 'deny')
})

test('hook real: borrar `dev` en el remoto se pregunta; borrar una rama de trabajo, no', () => {
  const dir = proyecto()
  for (const comando of ['git push origin --delete dev', 'git push origin -d dev', 'git push origin :dev', 'command git push origin :dev', 'git push origin --delete fix/M1-vieja dev']) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'ask', comando)
    assert.match(d.motivo, /BORRA la rama `dev`/, comando)
  }
  for (const comando of ['git push origin --delete fix/M1-vieja', 'git push origin :fix/M1-vieja', 'git push origin dev', 'git push --dry-run origin fix/M1-algo']) {
    assert.equal(decision(dir, comando), null, comando)
  }
  // Borrar main ya es tocar main: se deniega.
  assert.equal(decision(dir, 'git push origin --delete main')?.tipo, 'deny')
  assert.equal(decision(dir, 'git push origin :main')?.tipo, 'deny')
  // En modo solo no hay gates.
  assert.equal(decision(proyecto({ modo: 'solo' }), 'git push origin --delete dev'), null)
})

test('hook real: el push que lanza otro programa (start, Start-Process, Invoke-Command) tambien se ve', () => {
  const dir = proyecto()
  for (const comando of ['start git push origin main', 'start "" git push origin main', 'start /b git push origin HEAD:main']) {
    assert.equal(decision(dir, comando)?.tipo, 'deny', comando)
  }
  for (const comando of [
    'Start-Process git -ArgumentList "push","origin","main"',
    "Start-Process -FilePath git -ArgumentList 'push origin main' -Wait",
    'Start-Process -ArgumentList push,origin,main -FilePath "C:\\Program Files\\Git\\cmd\\git.exe"',
    "Start-Process powershell -ArgumentList '-Command git push origin main'",
    'saps git push,origin,main',
    'Invoke-Command -ScriptBlock { git push origin main }',
    'icm { git push origin main }',
    'Start-Job { git push origin main }',
  ]) {
    assert.equal(decision(dir, comando, { toolName: 'PowerShell' })?.tipo, 'deny', comando)
  }
  // A una rama de trabajo no se deniega, pero la lectura es aproximada: se pregunta.
  const d = decision(dir, 'Start-Process git -ArgumentList "push","origin","fix/M1-algo"', { toolName: 'PowerShell' })
  assert.equal(d?.tipo, 'ask')
  assert.match(d.motivo, /Start-Process/)
  assert.equal(decision(dir, 'start /b git push origin fix/M1-algo')?.tipo, 'ask')
  // Lanzar otra cosa no molesta.
  for (const [comando, toolName] of [
    ['Start-Process git -ArgumentList status', 'PowerShell'],
    ['Start-Process notepad notas.txt', 'PowerShell'],
    ['Start-Process gh -ArgumentList "pr","view"', 'PowerShell'],
    ['start notepad git-push-notas.txt', 'Bash'],
  ]) {
    assert.equal(decision(dir, comando, { toolName }), null, comando)
  }
  // En modo solo no hay gates.
  assert.equal(decision(proyecto({ modo: 'solo' }), 'start git push origin main'), null)
})

test('hook real: `git send-pack` y el refspec `:` suben main igual que un push', () => {
  const dir = proyecto()
  for (const comando of ['git send-pack origin main', 'git send-pack --all origin', 'command git send-pack origin HEAD:main', 'git push origin :', 'git push origin +:', 'git push -u origin :']) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'deny', comando)
    assert.match(d.motivo, /SHS-M42/, comando)
  }
  const d = decision(dir, 'git send-pack origin fix/M1-algo')
  assert.equal(d?.tipo, 'ask')
  assert.match(d.motivo, /send-pack/)
  // Borrar una rama de trabajo es `:rama`, no el `:` a secas: sigue sin molestar.
  assert.equal(decision(dir, 'git push origin :fix/M1-vieja'), null)
})

test('hook real: el trabajo normal no se toca (ni deny ni pregunta)', () => {
  const dir = proyecto()
  for (const comando of [
    'git push',
    'git push -u origin fix/M1-algo',
    'git push origin HEAD',
    'git push -u origin "$(git branch --show-current)"',
    'git push --follow-tags origin fix/M1-algo',
    'git push -o ci.skip origin fix/M1-algo',
    'git push origin v3.18.1',
    'command git push -u origin fix/M1-algo',
    'bash -c "git push origin fix/M1-algo"',
    'git fetch origin && git merge origin/dev && git push',
    // Hablar de un push no es hacerlo.
    'echo "git push origin main"',
    'echo git push origin main',
    'grep -rn "git push origin main" docs/',
    'git commit -m "docs: como hacer git push origin main (no se hace)"',
    'git log --grep="push --force" --oneline',
    'timeout 30 git status',
    'env FOO=1 node script.js --force',
    'time npm test',
    'bash deploy.sh',
  ]) {
    assert.equal(decision(dir, comando), null, comando)
  }
})

test('hook real: en modo solo no hay preguntas (ni por destino incierto ni por push forzado)', () => {
  const dir = proyecto({ modo: 'solo' })
  for (const comando of ['git push origin $B', 'git push origin fix/M1-algo --force', 'command git push origin main', 'git push origin +main']) {
    assert.equal(decision(dir, comando), null, comando)
  }
})

test('hook real: el Vault sigue exento tambien con un destino incierto; su push forzado si se pregunta', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'souclaude vault '))
  git(vault, 'init', '-q', '-b', 'main')
  git(vault, 'commit', '-q', '--allow-empty', '-m', 'chore: tablero')
  git(vault, 'remote', 'add', 'origin', 'https://github.com/soutecdev/soubunker-vault.git')
  const dir = proyecto()
  assert.equal(decision(dir, `git -C "${vault}" push origin "$RAMA"`), null)
  assert.equal(decision(dir, `cd "${vault}" && command git push origin main`), null)
  assert.equal(decision(dir, `bash -c 'cd "${vault}" && git push origin main'`), null)
  assert.equal(decision(dir, `git -C "${vault}" push origin main --force`)?.tipo, 'ask', 'nunca push --force, tampoco en el Vault')
})

function vaultDePrueba() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'souclaude vault '))
  git(vault, 'init', '-q', '-b', 'main')
  git(vault, 'commit', '-q', '--allow-empty', '-m', 'chore: tablero')
  git(vault, 'remote', 'add', 'origin', 'https://github.com/soutecdev/soubunker-vault.git')
  return vault
}

test('hook real: un `cd` que no llega al push no lo saca del proyecto', () => {
  const vault = vaultDePrueba()
  const dir = proyecto()
  for (const comando of [
    `(cd "${vault}"); git push origin main`,
    `(cd "${vault}") && git push origin main`,
    `echo $(cd "${vault}"); git push origin main`,
    `nohup cd "${vault}"; git push origin main`,
    `env cd "${vault}"; git push origin main`,
    `cd "${vault}" | cat; git push origin main`,
    `cd "${vault}" & git push origin main`,
    `cd "${vault}"; cd -; git push origin main`,
    `pushd "${vault}"; popd; git push origin main`,
    `cd "${vault}" || git push origin main`,
    `bash -c 'cd "${vault}"'; git push origin main`,
  ]) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'deny', comando)
    assert.match(d.motivo, /SHS-M42/, comando)
  }
  assert.equal(decision(dir, `Push-Location "${vault}"; Pop-Location; git push origin main`, { toolName: 'PowerShell' })?.tipo, 'deny')
  // El que si llega sigue yendo al Vault, que esta exento.
  for (const comando of [
    `cd "${vault}" && git push origin main`,
    `(cd "${vault}" && git push origin main)`,
    `command cd "${vault}" && git push origin main`,
    `{ cd "${vault}"; git push origin main; }`,
    `pushd "${vault}" && git push origin main && popd`,
    `cd "${vault}" || exit 1; git push origin main`,
    `eval 'cd "${vault}"'; git push origin main`,
  ]) {
    assert.equal(decision(dir, comando), null, comando)
  }
  for (const comando of [`(Set-Location "${vault}"); git push origin main`, `Push-Location "${vault}"; git push origin main; Pop-Location`]) {
    assert.equal(decision(dir, comando, { toolName: 'PowerShell' }), null, comando)
  }
})

test('hook real: con el `cd` a otra carpeta en un subshell, el check de secretos corre igual', () => {
  const dir = proyecto({ conReglas: true })
  fs.writeFileSync(path.join(dir, '.env'), 'CLAVE=valor\n')
  git(dir, 'add', '-f', '.env')
  git(dir, 'commit', '-q', '-m', 'chore: config')
  const otra = fs.mkdtempSync(path.join(os.tmpdir(), 'souclaude otra '))
  for (const comando of [
    'git push origin fix/M1-algo',
    `(cd "${otra}"); git push origin fix/M1-algo`,
    `nohup cd "${otra}"; git push origin fix/M1-algo`,
    `cd "${otra}" | cat; git push`,
    `cd "${otra}"; cd -; git push`,
    'cd "$(git rev-parse --show-toplevel)" && git push',
    'cd "$PWD" && git push -u origin fix/M1-algo',
  ]) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'deny', comando)
    assert.match(d.motivo, /SHS-M39/, comando)
    assert.match(d.motivo, /\.env/, comando)
  }
})

test('hook real: si no se puede saber en que carpeta corre el push, pregunta; si ahi toca main, deniega', () => {
  const vault = vaultDePrueba()
  const dir = proyecto()
  for (const comando of ['cd "$DESTINO" && git push', 'cd "$DESTINO" && git push origin fix/M1-algo', 'git -C "$DESTINO" push', 'true | cd otra; git push origin fix/M1-algo', 'cd -; git push']) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'ask', comando)
    assert.match(d.motivo, /no se sabe en que carpeta corre/, comando)
  }
  // Evaluado en el proyecto toca main: se deniega, y el motivo dice que la carpeta no se pudo leer.
  const d = decision(proyecto({ rama: 'main' }), 'cd "$DESTINO" && git push')
  assert.equal(d?.tipo, 'deny')
  assert.match(d.motivo, /no se sabe en que carpeta corre/)
  assert.match(d.motivo, /ruta literal/)
  assert.equal(decision(dir, 'cd "$DESTINO" && git push origin main')?.tipo, 'deny')
  // Con la sesion parada en el Vault, la exencion no alcanza si el cd puede llevar a otro lado.
  assert.equal(decision(dir, 'cd "$DESTINO" && git push', { cwd: vault })?.tipo, 'ask')
  assert.equal(decision(dir, 'cd "$DESTINO" && git push origin main', { cwd: vault })?.tipo, 'deny')
  assert.equal(decision(dir, 'cd "$DESTINO" && git push origin --delete dev', { cwd: vault })?.tipo, 'ask')
  assert.equal(decision(dir, 'git push origin main', { cwd: vault }), null, 'sin dudas, el Vault sigue exento')
  // En modo solo no hay preguntas.
  assert.equal(decision(proyecto({ modo: 'solo' }), 'cd "$DESTINO" && git push'), null)
})

test('hook real: un comentario con apostrofo no esconde el push a main; nombrarlo en un comentario no molesta', () => {
  const dir = proyecto()
  for (const comando of ["# Let's push the fix\ngit push origin main", "git fetch origin  # don't skip this\ngit push origin main", "echo listo # it's done\ngit push origin main"]) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'deny', comando)
    assert.match(d.motivo, /SHS-M42/, comando)
  }
  assert.equal(decision(dir, "# Let's push\ngit push origin main", { toolName: 'PowerShell' })?.tipo, 'deny')
  for (const comando of [
    'git push origin fix/M1-algo # no usar: git push origin main',
    'git push origin fix/M1-algo  # sube la rama; git push origin main seria un error',
    '# git push origin main\ngit push origin fix/M1-algo',
  ]) {
    assert.equal(decision(dir, comando), null, comando)
  }
})

test('hook real: `main` escrito en el comando se deniega aunque el remoto salga de una expresion', () => {
  const dir = proyecto()
  for (const comando of [
    'git push $(echo origin) main',
    'git push `echo origin` main',
    'git push "$REMOTO" HEAD:main',
    'X=`pwd` git push origin main',
    'X=`cat f` git push origin main',
    'X=$(cat f) git push origin main',
  ]) {
    const d = decision(dir, comando)
    assert.equal(d?.tipo, 'deny', comando)
    assert.match(d.motivo, /SHS-M42/, comando)
  }
  for (const comando of ['git push (Get-Remoto) main', 'git push origin (Get-Content rama.txt) main']) {
    assert.equal(decision(dir, comando, { toolName: 'PowerShell' })?.tipo, 'deny', comando)
  }
  // Parado en main, `git push $REMOTO` sube main: que el remoto no se pueda leer no cambia eso.
  assert.equal(decision(proyecto({ rama: 'main' }), 'git push $REMOTO')?.tipo, 'deny')
  assert.equal(decision(dir, 'git push $REMOTO')?.tipo, 'ask', 'en una rama de trabajo se pregunta')
})

// --- Avisos del check (no bloquean) ----------------------------------------------

test('avisos del check: se ven en la tabla del PR y le llegan al agente, sin volverse un fallo', () => {
  const resultados = [
    {
      grupo: 'secretos',
      bloqueante: true,
      status: 0,
      salida: '[OK  ] sin-secretos: sin archivos de credenciales agregados\n[AVISO] sin-secretos-en-contenido: posible credencial en las lineas agregadas (informativo, no bloquea): clave privada en src/a.js:3.',
    },
    { grupo: 'pr-metadata', bloqueante: true, status: 0, salida: '[OK  ] base-dev: ok' },
  ]
  const tabla = comentario({ sha: 'abcdef1234', resultados })
  assert.match(tabla, /\| secretos \| OK, con avisos \|/)
  assert.match(tabla, /\| pr-metadata \| OK \|/)
  assert.match(tabla, /\[AVISO\] sin-secretos-en-contenido/, 'el detalle va en la salida plegada del comentario')

  const paraElAgente = textoParaElAgente({ url: 'https://github.com/o/r/pull/1', sha: 'abcdef1234', resultados, errorComentario: null })
  assert.equal(paraElAgente.estado, 'ok', 'un aviso no es un fallo')
  assert.match(paraElAgente.texto, /secretos \[AVISO\] sin-secretos-en-contenido/)
  assert.match(paraElAgente.texto, /Los \[AVISO\] no bloquean, pero revisalos/)

  // Sin avisos, nada de esto aparece.
  const limpio = textoParaElAgente({ url: 'https://github.com/o/r/pull/1', sha: null, resultados: [resultados[1]], errorComentario: null })
  assert.doesNotMatch(limpio.texto, /AVISO/)
  assert.match(comentario({ sha: null, resultados: [resultados[1]] }), /\| pr-metadata \| OK \|/)
})
