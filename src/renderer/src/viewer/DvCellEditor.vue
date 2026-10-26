<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { editorFor } from './coltypes';

/**
 * The editor a grid cell gets from its column type: a dropdown for ENUM, tick
 * boxes for SET, a toggle for BOOLEAN, date / time pickers, a number input,
 * a JSON / long-text area, plain text otherwise. v-model is the string the
 * row update sends ('' = empty, null = NULL); ⏎ commits, Esc cancels.
 */
const props = defineProps<{ modelValue: string | null; type: string; nullable?: boolean; placeholder?: string; autofocus?: boolean; options?: string[]; form?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | null]; commit: []; cancel: [] }>();
// A PostgreSQL enum type names its values separately (options).
const ed = computed(() => (props.options?.length ? { kind: 'enum' as const, options: props.options } : editorFor(props.type)));
const el = ref<HTMLElement | null>(null);
onMounted(() => {
  if (props.autofocus) {
    const f = el.value?.querySelector<HTMLElement>('input, select, textarea');
    f?.focus();
    if (f instanceof HTMLInputElement && f.type === 'text') f.select();
  }
});
const set = (v: string | null) => emit('update:modelValue', v);
const v = computed(() => props.modelValue ?? '');
/** `2026-10-21 11:17:01` ⇄ `2026-10-21T11:17:01` for datetime-local. */
const dtLocal = computed(() => v.value.replace(' ', 'T').replace(/(\.\d+)?([+-]\d\d(:?\d\d)?|Z)?$/, '').slice(0, 19));
const onDt = (e: Event) => set((e.target as HTMLInputElement).value.replace('T', ' '));
const setValues = computed(() => new Set(v.value.split(',').map((x) => x.trim()).filter(Boolean)));
function toggleSet(opt: string) {
  const s = new Set(setValues.value);
  s.has(opt) ? s.delete(opt) : s.add(opt);
  set(ed.value.options.filter((o) => s.has(o)).join(','));
}
function keys(e: KeyboardEvent) {
  if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement && !(e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    emit('commit');
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    emit('cancel');
  }
}
</script>

<template>
  <span ref="el" class="dv-celled" :class="{ 'is-form': form }" @keydown="keys">
    <select v-if="ed.kind === 'enum'" :value="modelValue ?? ''" class="dv-cell-input" @change="set(($event.target as HTMLSelectElement).value)">
      <option value="">{{ nullable ? '(empty)' : '' }}</option>
      <option v-for="o in ed.options" :key="o" :value="o">{{ o }}</option>
    </select>
    <span v-else-if="ed.kind === 'set'" class="flex flex-wrap gap-x-2 gap-y-0.5 px-1">
      <label v-for="o in ed.options" :key="o" class="flex cursor-pointer items-center gap-1 text-[11px]"><input type="checkbox" class="checkbox checkbox-xs" :checked="setValues.has(o)" @change="toggleSet(o)" />{{ o }}</label>
    </span>
    <select v-else-if="ed.kind === 'bool'" :value="modelValue === null ? 'null' : /^(1|true|t|yes)$/i.test(v) ? '1' : v === '' ? '' : '0'" class="dv-cell-input" @change="set(($event.target as HTMLSelectElement).value === 'null' ? null : ($event.target as HTMLSelectElement).value)">
      <option value="1">true</option>
      <option value="0">false</option>
      <option v-if="nullable" value="null">NULL</option>
      <option value="" hidden />
    </select>
    <input v-else-if="ed.kind === 'datetime'" type="datetime-local" step="1" :value="dtLocal" class="dv-cell-input" @input="onDt" />
    <input v-else-if="ed.kind === 'date'" type="date" :value="v.slice(0, 10)" class="dv-cell-input" @input="set(($event.target as HTMLInputElement).value)" />
    <input v-else-if="ed.kind === 'time'" type="time" step="1" :value="v.slice(0, 8)" class="dv-cell-input" @input="set(($event.target as HTMLInputElement).value)" />
    <input v-else-if="ed.kind === 'number'" type="text" inputmode="decimal" :value="v" :placeholder="placeholder" class="dv-cell-input text-right tabular-nums" pattern="-?[0-9]*([.,][0-9]+)?([eE][+-]?[0-9]+)?" @input="set(($event.target as HTMLInputElement).value)" />
    <textarea v-else-if="ed.kind === 'json' || ed.kind === 'textarea'" :value="v" :placeholder="placeholder" class="dv-cell-input dv-cell-area" rows="3" spellcheck="false" @input="set(($event.target as HTMLTextAreaElement).value)" />
    <input v-else type="text" :value="v" :placeholder="placeholder" class="dv-cell-input" spellcheck="false" @input="set(($event.target as HTMLInputElement).value)" />
  </span>
</template>
