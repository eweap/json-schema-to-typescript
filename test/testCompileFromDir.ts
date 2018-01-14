import { test } from 'ava'
import { compileFromDir } from '../src'

export function run() {

  test('compileFromDir should compile all files in directory', async t =>
    t.snapshot(await compileFromDir('./test/resources/dir'))
  )

}
