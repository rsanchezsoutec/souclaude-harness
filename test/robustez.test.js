import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/cli.js'
import { mkRepo, read, write, has, snapshot } from './helpers.js'
import { readLockfile } from '../src/core/lockfile.js'
import { parseJson, sinBom } from '../src/core/jsonmerge.js'

// Entradas que en la practica llegan rotas de formas previsibles: un JSON
// guardado con BOM por una herramienta de Windows, y un lockfile que quedo con
// marcadores de conflicto porque dos ramas corrieron `upgrade`.
const YES = ['--yes', '--name', 'acme', '--type', 'backend', '--lang', 'es']
const BOM = '\uFEFF'

test('sinBom / parseJson: el BOM inicial no vuelve invalido un JSON', () => {
  assert.equal(sinBom(`${BOM}{"a":1}`), '{"a":1}')
  assert.equal(sinBom('{"a":1}'), '{"a":1}')
  assert.equal(sinBom(null), null)
  assert.deepEqual(parseJson(`${BOM}{"a":1}`, 'x.json'), { a: 1 })
  assert.throws(() => parseJson('{ roto', 'x.json'), /x\.json no es JSON valido/)
})

test('upgrade: un settings.json guardado con BOM (PowerShell 5.1) no aborta el upgrade', async () => {
  const dir = mkRepo({ 'package.json': '{"name":"acme"}\n' })
  assert.equal(await main(['init', ...YES], dir), 0)
  const settings = JSON.parse(read(dir, '.claude/settings.json'))
  settings.model = 'sonnet' // una preferencia del usuario que tiene que sobrevivir
  write(dir, '.claude/settings.json', BOM + JSON.stringify(settings, null, 2))

  assert.equal(await main(['upgrade', ...YES], dir), 0)
  const despues = read(dir, '.claude/settings.json')
  assert.notEqual(despues.charCodeAt(0), 0xfeff, 'el settings.json reescrito conserva el BOM')
  assert.equal(JSON.parse(despues).model, 'sonnet')
})

test('lockfile con BOM se lee igual; vacio o ausente es "sin harness"', () => {
  const dir = mkRepo({ '.claude/harness.json': `${BOM}{"harnessVersion":"3.0.0"}` })
  assert.equal(readLockfile(dir).harnessVersion, '3.0.0')
  assert.deepEqual(readLockfile(dir).files, {})
  assert.equal(readLockfile(mkRepo({ '.claude/harness.json': '' })), null)
  assert.equal(readLockfile(mkRepo({})), null)
})

test('lockfile dañado: error que lo nombra, en vez de tratar al repo como "sin harness"', async () => {
  const dir = mkRepo({ 'package.json': '{"name":"acme"}\n' })
  assert.equal(await main(['init', ...YES], dir), 0)
  write(dir, 'CLAUDE.md', `${read(dir, 'CLAUDE.md')}\nuna regla del equipo\n`)
  const original = read(dir, '.claude/harness.json')

  for (const dañado of [
    `<<<<<<< HEAD\n${original}=======\n${original}>>>>>>> otra-rama\n`, // conflicto de merge sin resolver
    original.slice(0, Math.floor(original.length / 2)), // truncado
    '[]',
    '"texto"',
    '{"files": []}',
  ]) {
    write(dir, '.claude/harness.json', dañado)
    assert.throws(() => readLockfile(dir), /\.claude\/harness\.json existe pero no es un lockfile valido/)
    const antes = snapshot(dir, { includeLockfile: true })
    // Ni el comando explicito ni la autodeteccion (sin comando) lo toman por un repo sin harness.
    for (const argv of [['upgrade', ...YES], ['status'], YES]) {
      assert.equal(await main(argv, dir), 1, `${argv[0]} deberia fallar con el lockfile dañado`)
    }
    assert.equal(snapshot(dir, { includeLockfile: true }), antes, 'se escribio algo con el lockfile dañado')
    assert.ok(!has(dir, 'CLAUDE.md.new'))
  }

  // Reparado, todo sigue como antes.
  write(dir, '.claude/harness.json', original)
  assert.equal(await main(['upgrade', ...YES], dir), 0)
})
