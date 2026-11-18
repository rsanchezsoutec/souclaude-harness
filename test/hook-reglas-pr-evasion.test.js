import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  segmentos,
  comandoEfectivo,
  comandoAnidado,
  pushForzado,
  destinosDelPush,
  pushDelComando,
  cambioDePR,
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
  assert.deepEqual(comandoEfectivo(['xargs', '-n1', 'git', 'push', 'origin']), { p: ['git', 'push', 'origin'], viaXargs: true })
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
  assert.deepEqual(comandoAnidado(['cmd', '/c', 'git', 'push', 'origin', 'main']), { comando: 'git push origin main', shell: 'bash' })
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

test('cambioDePR: tambien ve `gh pr create` detras de un envoltorio', () => {
  assert.equal(cambioDePR('command gh pr create --fill', CWD)?.accion, 'create')
  assert.equal(cambioDePR('env GH_PAGER= gh pr edit 12 --body-file b.md', CWD)?.accion, 'edit')
  assert.equal(cambioDePR('echo gh pr create', CWD), null)
})

// --- El hook real, como lo corre Claude Code ------------------------------------

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function proyecto({ modo = null, rama = 'fix/M1-algo' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souclaude evasion '))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: raiz')
  if (rama !== 'main') git(dir, 'switch', '-q', '-c', rama)
  git(dir, 'remote', 'add', 'origin', 'https://github.com/soutecdev/app-de-ejemplo.git')
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true })
  fs.copyFileSync(HOOK, path.join(dir, '.claude', 'hooks', 'reglas-pr.mjs'))
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
