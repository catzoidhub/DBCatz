<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DbEngine } from '@shared/types';
import { BASE_TYPES, composeType, parseType, type TypeChoice } from './coltypes';

/**
 * A column type picked, not typed: a grouped dropdown of the engine's types,
 * then the parameters that type takes — length (VARCHAR 255), precision and
 * scale (DECIMAL 10,2) or the values of an ENUM / SET. v-model is the type
 * string the server gets (`varchar(255)`, `enum('a','b')`).
 */
const props = defineProps<{ modelValue: string; engine: DbEngine; compact?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const types = BASE_TYPES[props.engine];
const groups = computed(() => {
  const out = new Map<string, typeof types>();
  for (const t of types) (out.get(t.group) ?? out.set(t.group, []).get(t.group)!).push(t);
  return [...out.entries()];
});
const choice = ref<TypeChoice>(parseType(props.engine, props.modelValue));
const base = computed(() => types.find((t) => t.name.toLowerCase() === choice.value.base.toLowerCase()));
const params = computed(() => base.value?.params ?? (/^(enum|set)$/i.test(choice.value.base) ? ['values'] : []));
const custom = computed(() => !base.value && !!choice.value.base);
const valuesText = ref(choice.value.values.join(', '));

watch(
  () => props.modelValue,
  (v) => {
    if (v !== composeType(props.engine, choice.value)) {
      choice.value = parseType(props.engine, v);
      valuesText.value = choice.value.values.join(', ');
    }
  },
);
function pick(name: string) {
  const t = types.find((x) => x.name === name);
  choice.value = { base: name, length: t?.length ?? null, scale: t?.scale ?? null, values: [], suffix: '' };
  valuesText.value = '';
  push();
}
function push() {
  choice.value.values = valuesText.value.split(',').map((v) => v.trim()).filter(Boolean);
  emit('update:modelValue', composeType(props.engine, choice.value));
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-1">
    <select :value="base?.name ?? '__custom'" class="select min-w-0 flex-1 font-mono" :class="compact ? 'select-xs' : 'select-sm'" @change="pick(($event.target as HTMLSelectElement).value)">
      <optgroup v-for="[g, list] in groups" :key="g" :label="g">
        <option v-for="t in list" :key="t.name" :value="t.name">{{ t.name }}</option>
      </optgroup>
      <option v-if="custom" value="__custom">{{ choice.base }}</option>
    </select>
    <template v-if="params.includes('length')">
      <input v-model.number="choice.length" type="number" min="1" class="input w-16 font-mono" :class="compact ? 'input-xs' : 'input-sm'" title="Length" placeholder="len" @input="push" />
    </template>
    <template v-else-if="params.includes('precision')">
      <input v-model.number="choice.length" type="number" min="1" class="input w-14 font-mono" :class="compact ? 'input-xs' : 'input-sm'" title="Precision (digits)" placeholder="10" @input="push" />
      <span class="opacity-50">,</span>
      <input v-model.number="choice.scale" type="number" min="0" class="input w-12 font-mono" :class="compact ? 'input-xs' : 'input-sm'" title="Scale (decimals)" placeholder="2" @input="push" />
    </template>
    <template v-else-if="params.includes('values')">
      <input v-model="valuesText" class="input min-w-24 flex-[2] font-mono" :class="compact ? 'input-xs' : 'input-sm'" title="Values, comma-separated" placeholder="small, medium, large" required @input="push" />
    </template>
    <input v-if="custom" v-model="choice.suffix" class="input w-24 font-mono" :class="compact ? 'input-xs' : 'input-sm'" title="Type modifiers" placeholder="e.g. unsigned" @input="push" />
  </div>
</template>
