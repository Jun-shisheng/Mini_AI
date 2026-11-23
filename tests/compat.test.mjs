import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('Android WebView fallbacks cover recent array methods and cryptographic UUIDs', () => {
  const context = vm.createContext({crypto:{getRandomValues(bytes){for(let i=0;i<bytes.length;i++)bytes[i]=i;return bytes;}}});
  vm.runInContext('delete Array.prototype.at; delete Array.prototype.findLast; delete Array.prototype.findLastIndex;', context);
  vm.runInContext(readFileSync(new URL('../src/compat.js', import.meta.url),'utf8'), context);
  assert.equal(vm.runInContext('[10,20,30].at(-2)',context),20);
  assert.equal(vm.runInContext('[10,20].at(99)',context),undefined);
  assert.equal(vm.runInContext('[10,20].at(Infinity)',context),undefined);
  assert.equal(vm.runInContext('[1,2,3,4].findLast(x=>x%2===0)',context),4);
  assert.equal(vm.runInContext('[1,2,3,4].findLastIndex(x=>x%2===0)',context),3);
  assert.equal(vm.runInContext('[1,2].findLastIndex(x=>x===9)',context),-1);
  assert.equal(vm.runInContext('crypto.randomUUID()',context),'00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.equal(vm.runInContext('Object.keys([]).includes("at")',context),false);
});

test('existing platform methods are preserved', () => {
  const context=vm.createContext({crypto:{randomUUID:()=> 'native'}});
  vm.runInContext('this.beforeAt=Array.prototype.at;',context);
  vm.runInContext(readFileSync(new URL('../src/compat.js',import.meta.url),'utf8'),context);
  assert.equal(vm.runInContext('beforeAt===Array.prototype.at',context),true);
  assert.equal(vm.runInContext('crypto.randomUUID()',context),'native');
});
