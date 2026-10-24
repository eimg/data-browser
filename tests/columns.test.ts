import assert from 'node:assert/strict';
import test from 'node:test';
import { editableColumn, fromColumn, type Column } from '../src/data/types';

function column(type: string, extra = '', defaultValue: string | null = null): Column {
  return { name: 'value', type, nullable: true, defaultValue, extra, columnKey: '', expression: '', binary: false, generated: false };
}

test('maps PostgreSQL column types into the edit form', () => {
  assert.equal(fromColumn(column('integer'), true).type, 'INTEGER');
  assert.equal(fromColumn(column('double precision'), true).type, 'DOUBLE PRECISION');
  assert.equal(fromColumn(column('character varying(32)'), true).type, 'VARCHAR');
  assert.equal(fromColumn(column('character varying(32)'), true).length, '32');
  assert.equal(fromColumn(column('numeric(12,2)'), true).type, 'NUMERIC');
  assert.equal(fromColumn(column('numeric(12,2)'), true).scale, '2');
  assert.equal(editableColumn(column('text'), true), true);
  assert.equal(editableColumn(column('integer', 'identity'), true), false);
  assert.equal(editableColumn(column('text', '', "nextval('notes_id_seq'::regclass)"), true), false);
  assert.equal(editableColumn(column('varchar(40)')), true);
});
