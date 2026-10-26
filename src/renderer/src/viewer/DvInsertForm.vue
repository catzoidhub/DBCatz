<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { DvColumn } from '@shared/types';
import DvCellEditor from './DvCellEditor.vue';
import { editorFor } from './coltypes';

/**
 * New row: one field per column with the same typed editor as editing a cell
 * (ENUM dropdown, BOOLEAN, date / time pickers, numbers, JSON …), and for each
 * field what to send — the column's Default (left out of the INSERT), NULL, or
 * a Value (an empty value is an empty string, not NULL).
 */
const props = defineProps<{ table: string; columns: DvColumn[]; rowWord: string; busy?: boolean }>();
const emit = defineEmits<{ save: [values: Record<string, unknown>]; cancel: [] }>();

type Mode = 'default' | 'null' | 'value';
/** A column without a default, not auto-filled and NOT NULL needs a value. */
const required = (c: DvColumn) => !c.nullable && !c.autoIncrement && (c.default === null || c.default === undefined || c.default === '');
const canDefault = (c: DvColumn) => !required(c);
const fields = reactive(
  Object.fromEntries(props.columns.map((c) => [c.name, { mode: (required(c) ? 'value' : 'default') as Mode, value: '' as string | null }])),
);
const defaultText = (c: DvColumn) => (c.autoIncrement ? 'auto' : c.default !== null && c.default !== undefined && c.default !== '' ? c.default : c.nullable ? 'NULL' : '');
const kindLabel = (c: DvColumn) => {
  const k = c.options?.length ? 'enum' : editorFor(c.type).kind;
  return k === 'text' ? '' : k;
};
function onEdit(name: string, v: string | null) {
  const f = fields[name];
  f.value = v;
  if (v === null) f.mode = 'null';
  else f.mode = 'value';
}
const filled = computed(() => Object.values(fields).filter((f) => f.mode !== 'default').length);
function save() {
  const values: Record<string, unknown> = {};
  for (const c of props.columns) {
    const f = fields[c.name];
    if (f.mode === 'null') values[c.name] = null;
    else if (f.mode === 'value') values[c.name] = f.value ?? '';
  }
  emit('save', values);
}
const first = ref<HTMLElement | null>(null);
onMounted(() => first.value?.querySelector<HTMLElement>('input, select, textarea')?.focus());
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc.stop="!busy && emit('cancel')" @keydown.meta.enter.prevent="!busy && save()" @keydown.ctrl.enter.prevent="!busy && save()">
    <form class="modal-box flex max-h-[88vh] w-[46rem] max-w-[95vw] flex-col p-0" @submit.prevent="save">
      <div class="flex items-center gap-3 border-b border-base-300/60 px-6 pt-5 pb-4">
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">New {{ rowWord }}</h3>
          <p class="truncate text-xs opacity-60">into <span class="font-mono">{{ table }}</span> · each field is sent as its default, NULL, or the value you set</p>
        </div>
      </div>

      <div class="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3">
        <div v-for="(c, i) in columns" :key="c.name" :ref="i === 0 ? (el) => (first = el as HTMLElement) : undefined" class="dv-ins-field" :class="{ 'is-off': fields[c.name].mode !== 'value' }">
          <div class="dv-ins-label">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-mono text-[13px] font-semibold">{{ c.name }}</span>
              <span v-if="c.key" class="dv-key-tag is-pk" title="Primary key">PK</span>
              <span v-if="required(c)" class="text-error" title="Required: NOT NULL without a default">*</span>
            </div>
            <div class="mt-0.5 flex items-center gap-1.5 text-[11px] opacity-55">
              <span class="truncate font-mono">{{ c.type || 'any' }}</span>
              <span v-if="kindLabel(c)" class="tracking-wide uppercase">· {{ kindLabel(c) }}</span>
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <DvCellEditor
                  v-if="fields[c.name].mode === 'value'"
                  :model-value="fields[c.name].value"
                  :type="c.type"
                  :options="c.options"
                  :nullable="c.nullable"
                  form
                  @update:model-value="onEdit(c.name, $event)"
                  @commit="save"
                  @cancel="emit('cancel')"
                />
                <button v-else type="button" class="dv-ins-placeholder" :title="'Set a value'" @click="fields[c.name].mode = 'value'">
                  <template v-if="fields[c.name].mode === 'null'"><span class="italic">NULL</span></template>
                  <template v-else>
                    <span class="opacity-70">Default</span><span v-if="defaultText(c)" class="font-mono opacity-60"> · {{ defaultText(c) }}</span>
                  </template>
                  <span class="ml-auto text-[11px] opacity-50">set a value</span>
                </button>
              </div>
              <div class="flex w-[11.5rem] shrink-0 justify-end">
              <div role="tablist" class="seg seg-xs">
                <a v-if="canDefault(c)" role="tab" class="seg-item normal-case" :class="{ 'is-active': fields[c.name].mode === 'default' }" :title="`Leave it to the column default (${defaultText(c) || 'none'})`" @click="fields[c.name].mode = 'default'">Default</a>
                <a v-if="c.nullable" role="tab" class="seg-item normal-case" :class="{ 'is-active': fields[c.name].mode === 'null' }" title="Store NULL" @click="fields[c.name].mode = 'null'">NULL</a>
                <a role="tab" class="seg-item normal-case" :class="{ 'is-active': fields[c.name].mode === 'value' }" title="Type a value (empty = empty string)" @click="fields[c.name].mode = 'value'">Value</a>
              </div>
              </div>
            </div>
            <p v-if="c.comment" class="mt-1 truncate text-[11px] opacity-50">{{ c.comment }}</p>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 border-t border-base-300/60 px-6 py-3">
        <span class="text-xs opacity-55">{{ filled }} of {{ columns.length }} set · the rest use their defaults</span>
        <span class="flex-1" />
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel <kbd class="kbd kbd-xs ml-1 opacity-60">esc</kbd></button>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="busy">
          <span v-if="busy" class="loading loading-spinner loading-xs" />Insert {{ rowWord }} <kbd class="kbd kbd-xs ml-1 border-0 bg-white/20 text-current">⌘⏎</kbd>
        </button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
