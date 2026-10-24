import Dialog from './Dialog';
import SqlBlock from './SqlBlock';

const createExample = (sqlite: boolean) => `CREATE TABLE customers (
  id ${sqlite ? 'INTEGER' : 'BIGINT'} PRIMARY KEY
);

CREATE TABLE orders (
  id ${sqlite ? 'INTEGER' : 'BIGINT'} PRIMARY KEY,
  customer_id ${sqlite ? 'INTEGER' : 'BIGINT'} NOT NULL,
  CONSTRAINT fk_orders_customer
    FOREIGN KEY (customer_id) REFERENCES customers(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);`;

export default function ForeignKeyExamples({ sqlite, context, onClose }: {
  sqlite: boolean; context: 'create' | 'structure'; onClose: () => void;
}) {
  const examples = context === 'create' || sqlite ? [
    { title: 'Create table', sql: createExample(sqlite) },
  ] : [
    { title: 'Add foreign key', sql: `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;` },
    { title: 'Remove foreign key', sql: 'ALTER TABLE orders\n  DROP FOREIGN KEY fk_orders_customer;' },
  ];

  return <Dialog title="Foreign keys" busy={false} onClose={onClose} onSubmit={() => {}} showSubmit={false} cancel="Close">
    <p className="db-hint">{sqlite ? 'SQLite' : 'MySQL'} · SQL {examples.length === 1 ? 'example' : 'examples'}</p>
    {sqlite && context === 'structure' && <p>To add or remove a foreign key on existing columns, rebuild the table with the updated definition.</p>}
    {examples.map(example => <SqlBlock key={example.title} title={example.title} sql={example.sql} />)}
  </Dialog>;
}
