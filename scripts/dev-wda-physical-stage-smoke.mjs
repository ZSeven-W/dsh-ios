/** Mock/tempfs smoke for physical WDA stage integrity. Never invokes Xcode or a device. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(new URL('.', import.meta.url).pathname, '..')
const { PHYSICAL_WDA_DEFAULT_PATCHES, PhysicalWdaStageError, stagePhysicalWdaSource } = await import(join(root, 'src', 'wda-physical-stage.ts'))
const base = await mkdtemp(join(tmpdir(), 'dsh-ios-physical-stage-'))
const source = join(base, 'source')
const state = join(base, 'state')
const patch = PHYSICAL_WDA_DEFAULT_PATCHES.patches
const files = new Map(patch.map(item => [item.file, item.oldText]))
for (const [file, content] of files) {
  const path = join(source, file)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}
await mkdir(join(source, 'WebDriverAgent.xcodeproj'), { recursive: true })
await writeFile(join(source, 'LICENSE'), 'license\n')
const originals = new Map(await Promise.all([...files].map(async ([file]) => [file, await readFile(join(source, file), 'utf8')])))

try {
  const first = await stagePhysicalWdaSource(source, state)
  assert.notEqual(first.stageDir, source)
  for (const [file, content] of originals) assert.equal(await readFile(join(source, file), 'utf8'), content, 'source was modified')
  const second = await stagePhysicalWdaSource(source, state)
  assert.equal(second.stageDir, first.stageDir, 'valid cache was not reused')

  await writeFile(join(first.stageDir, patch[0].file), 'tampered\n')
  const repaired = await stagePhysicalWdaSource(source, state)
  assert.notEqual(repaired.stageDir, first.stageDir, 'tampered cache was silently reused/deleted')
  assert.match(await readFile(join(repaired.stageDir, patch[0].file), 'utf8'), /127\.0\.0\.1/)

  const symlinkSource = join(base, 'symlink-source')
  await mkdir(symlinkSource, { recursive: true })
  await symlink(source, join(symlinkSource, 'link'))
  await assert.rejects(stagePhysicalWdaSource(symlinkSource, join(base, 'symlink-state')), error => error instanceof PhysicalWdaStageError)

  const concurrent = await Promise.all([1, 2, 3, 4].map(() => stagePhysicalWdaSource(source, join(base, 'concurrent-state'))))
  assert.equal(new Set(concurrent.map(item => item.stageDir)).size, 1, 'concurrent staging did not converge on one private stage')
  console.log('PASS physical stage cache integrity, patch verification, symlink rejection, source immutability, and concurrent publish')
} finally {
  await rm(base, { recursive: true, force: true })
}
