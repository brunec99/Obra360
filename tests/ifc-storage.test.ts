import test from 'node:test';
import assert from 'node:assert/strict';
import { ifcStoragePrefix, isIfcStoragePathOf } from '../src/domain/ifc-storage';

const model = { id: 'm1', workId: 'w1' };
const uuid = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

test('o caminho que o upload-url gera para o modelo vale', () => {
  assert.equal(ifcStoragePrefix('w1', 'm1'), 'w1/m1/');
  assert.equal(isIfcStoragePathOf(`w1/m1/${uuid}-Torre_A.frag`, model, 'frag'), true);
  assert.equal(isIfcStoragePathOf(`w1/m1/${uuid}-Torre_A.IFC`, model, 'ifc'), true);
  assert.equal(isIfcStoragePathOf(`w1/m1/${uuid}-Torre_A.frag`, model), true);
});

test('arquivo de outra obra ou de outro modelo é recusado', () => {
  assert.equal(isIfcStoragePathOf(`w2/m9/${uuid}-Torre_A.frag`, model, 'frag'), false);
  assert.equal(isIfcStoragePathOf(`w1/m2/${uuid}-Torre_A.frag`, model, 'frag'), false);
  assert.equal(isIfcStoragePathOf(`w1/m10/${uuid}-x.frag`, model, 'frag'), false);
});

test('subpasta, volta de pasta, nome sem uuid e extensão trocada são recusados', () => {
  assert.equal(isIfcStoragePathOf(`w1/m1/../../w2/m9/${uuid}-x.frag`, model, 'frag'), false);
  assert.equal(isIfcStoragePathOf(`w1/m1/${uuid}-..frag`, model, 'frag'), false);
  assert.equal(isIfcStoragePathOf(`w1/m1/sub/${uuid}-x.frag`, model, 'frag'), false);
  assert.equal(isIfcStoragePathOf('w1/m1/x.frag', model, 'frag'), false);
  assert.equal(isIfcStoragePathOf(`w1/m1/${uuid}-x.ifc`, model, 'frag'), false);
  assert.equal(isIfcStoragePathOf('', model), false);
});
