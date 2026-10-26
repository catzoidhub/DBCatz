<script setup lang="ts">
import { computed } from 'vue';
import type { DbEngine, DvCharsets, DvColumnDef } from '@shared/types';

/**
 * Character set, collation and comment of one column. Character set and
 * collation only for text types (MySQL: both, the collation list follows
 * the set; PostgreSQL: collation; SQLite: BINARY / NOCASE / RTRIM); SQLite
 * has no comments. Empty = the table's default.
 */
const props = defineProps<{ column: DvColumnDef; engine: DbEngine; sets: DvCharsets; compact?: boolean }>();
const mysql = computed(() => props.engine === 'mysql' || props.engine === 'mariadb');
const textType = computed(() => /^(var)?char|^character|text|^enum|^set\b|^citext|^string|^nvarchar|^nchar/i.test(props.column.type.trim()));
const collations = computed(() => {
  if (props.engine === 'sqlite') return ['BINARY', 'NOCASE', 'RTRIM'];
  const all = props.sets.collations;
  return (mysql.value && props.column.charset ? all.filter((c) => c.charset === props.column.charset) : all).map((c) => c.name);
});
function onCharset() {
  // A collation of another set does not fit: back to the set's default.
  if (props.column.collation && !collations.value.includes(props.column.collation)) props.column.collation = '';
}
const size = computed(() => (props.compact ? 'select-xs' : 'select-sm'));
const isize = computed(() => (props.compact ? 'input-xs' : 'input-sm'));
</script>

<template>
  <div class="grid grid-cols-6 gap-3">
    <template v-if="textType">
      <label v-if="mysql" class="col-span-2 block">
        <span class="dv-label">Character set</span>
        <select v-model="column.charset" class="select w-full font-mono" :class="size" @change="onCharset">
          <option value="">table default</option>
          <option v-for="c in sets.charsets" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
      <label :class="mysql ? 'col-span-2' : 'col-span-3'" class="block">
        <span class="dv-label">Collation</span>
        <select v-model="column.collation" class="select w-full font-mono" :class="size">
          <option value="">{{ mysql && column.charset ? `${column.charset} default` : 'default' }}</option>
          <option v-for="c in collations" :key="c" :value="c">{{ c }}</option>
        </select>
      </label>
    </template>
    <label v-if="engine !== 'sqlite'" :class="textType ? (mysql ? 'col-span-2' : 'col-span-3') : 'col-span-6'" class="block">
      <span class="dv-label">Comment</span>
      <input v-model="column.comment" class="input w-full" :class="isize" placeholder="What this column holds" spellcheck="false" />
    </label>
    <p v-if="!textType && engine === 'sqlite'" class="col-span-6 text-[11px] opacity-50">Nothing more to set for this type in SQLite.</p>
  </div>
</template>
