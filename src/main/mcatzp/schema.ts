import type { DvAlterOp, DvColumnDef } from '@shared/types';

/** Columns and table changes as clients send them: shared by check_alter (read) and alter_table (change). */
const S = (description: string, maxLength = 512) => ({ type: 'string', minLength: 1, maxLength, description });
export const COLUMN = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type'],
  properties: { name: S('Column name.', 128), type: S('A type from list_column_types, such as VARCHAR(255).', 128), nullable: { type: 'boolean' }, default: { type: 'string', maxLength: 500 }, primary: { type: 'boolean' }, auto_increment: { type: 'boolean' }, unique: { type: 'boolean' }, comment: { type: 'string', maxLength: 500 } },
};
export const ALTER_OPS = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  description: 'What to change, in order.',
  items: {
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['op', 'column'], properties: { op: { const: 'addColumn' }, column: COLUMN, after: S('Put it after this column (MySQL, MariaDB).', 128) } },
      { type: 'object', additionalProperties: false, required: ['op', 'name'], properties: { op: { const: 'dropColumn' }, name: S('The column.', 128) } },
      { type: 'object', additionalProperties: false, required: ['op', 'from', 'to'], properties: { op: { const: 'renameColumn' }, from: S('The column.', 128), to: S('Its new name.', 128) } },
      { type: 'object', additionalProperties: false, required: ['op', 'column'], properties: { op: { const: 'modifyColumn' }, column: COLUMN } },
      { type: 'object', additionalProperties: false, required: ['op', 'name', 'columns'], properties: { op: { const: 'addIndex' }, name: S('The index.', 128), columns: { type: 'array', minItems: 1, maxItems: 32, items: S('A column.', 128) }, unique: { type: 'boolean' } } },
      { type: 'object', additionalProperties: false, required: ['op', 'name'], properties: { op: { const: 'dropIndex' }, name: S('The index.', 128) } },
      { type: 'object', additionalProperties: false, required: ['op', 'to'], properties: { op: { const: 'renameTable' }, to: S('The new name.', 128) } },
    ],
  },
};

export const column = (c: Record<string, unknown>): DvColumnDef => ({ name: String(c.name), type: String(c.type), nullable: c.nullable !== false && c.primary !== true, default: String(c.default ?? ''), primary: c.primary === true, autoIncrement: c.auto_increment === true, unique: c.unique === true, comment: String(c.comment ?? '') });
export function alterOps(raw: unknown): DvAlterOp[] {
  return (raw as Record<string, unknown>[]).map((o) => {
    if (o.op === 'addColumn') return { op: 'addColumn', column: column(o.column as Record<string, unknown>), after: (o.after as string | undefined) ?? null };
    if (o.op === 'modifyColumn') return { op: 'modifyColumn', column: column(o.column as Record<string, unknown>) };
    if (o.op === 'addIndex') return { op: 'addIndex', name: String(o.name), columns: o.columns as string[], unique: o.unique === true };
    return o as unknown as DvAlterOp;
  });
}
