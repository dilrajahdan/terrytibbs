<template>
  <div class="correction-settings">
    <label class="toggle" for="correctionsEnabled">
      <input id="correctionsEnabled" type="checkbox" :checked="enabled" @change="$emit('enabled', ($event.target as HTMLInputElement).checked)" />
      <span class="toggle-track" aria-hidden="true"></span>
      <span><strong>Apply saved corrections</strong><small>Whole words and phrases only. No AI call, upload or background reading of your text boxes.</small></span>
    </label>
    <p>Use <strong>Correct words</strong> below your latest transcript to learn from an edit, or add a pair here. Save settings to apply changes.</p>
    <p v-if="!rules.length" role="status">No corrections saved yet.</p>
    <ul v-else class="correction-list" aria-label="Saved corrections">
      <li v-for="(rule, index) in rules" :key="rule.from">
        <span>{{ rule.from }} → <strong>{{ rule.to }}</strong></span>
        <button class="button secondary small" type="button" :aria-label="`Remove correction for ${rule.from}`" @click="remove(index)">Remove</button>
      </li>
    </ul>
    <div class="correction-add">
      <div class="field"><label for="correctionFrom">When Terry writes</label><input id="correctionFrom" v-model="from" maxlength="80" placeholder="Shunade" /></div>
      <div class="field"><label for="correctionTo">Replace with</label><input id="correctionTo" v-model="to" maxlength="80" placeholder="Sinead" /></div>
      <button class="button secondary small" type="button" :disabled="!from.trim() || !to.trim()" @click="add">Add correction</button>
    </div>
    <p v-if="message" :class="{ 'field-error': failed }" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { Correction } from '../../shared/types'
import { validateCorrections } from '../../shared/corrections'
const props = defineProps<{ rules: Correction[]; enabled: boolean }>()
const emit = defineEmits<{ update: [rules: Correction[]]; enabled: [enabled: boolean] }>()
const from = ref(''), to = ref(''), message = ref(''), failed = ref(false)
function add(): void {
  try {
    const rules = validateCorrections([...props.rules, { from: from.value, to: to.value }])
    emit('update', rules); from.value = ''; to.value = ''; failed.value = false
    message.value = 'Added to this draft. Save settings to remember it.'
  } catch (error) { failed.value = true; message.value = error instanceof Error ? error.message : 'Check the correction.' }
}
function remove(index: number): void {
  emit('update', props.rules.filter((_, position) => position !== index))
  failed.value = false; message.value = 'Removed from this draft. Save settings to apply.'
}
</script>
