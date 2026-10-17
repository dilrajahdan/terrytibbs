<template>
  <div class="correction-learner">
    <button v-if="!editing" class="button secondary small" type="button" :disabled="busy" @click="begin">Correct words</button>
    <section v-else class="correction-editor" aria-label="Learn word corrections">
      <label for="corrected-transcript">Corrected transcript</label>
      <p>Fix the names or words Terry misheard, then review what to remember. Everything stays on this Mac.</p>
      <textarea id="corrected-transcript" v-model="corrected" rows="5" maxlength="10000" :disabled="saving || busy" @input="reviewed = false" />
      <button class="button secondary small" type="button" :disabled="saving || busy" @click="review">Review word changes</button>
      <template v-if="reviewed">
        <p v-if="!suggestions.length" role="status">No small word replacements found. Punctuation, added words and broad rewrites are not learned. Add a specific pair in Settings → Saved corrections.</p>
        <template v-else>
          <p>Selected pairs will replace matching words in future dictations. Only remember changes you want every time.</p>
          <label v-for="(rule, index) in suggestions" :key="index" class="correction-choice">
            <input v-model="selected" type="checkbox" :value="index" :disabled="saving || busy" />
            <span><del>{{ rule.from }}</del> → <strong>{{ rule.to }}</strong></span>
          </label>
          <p v-if="!enabled" class="notice">Saved corrections are paused. Enable them in Settings to apply these to future dictations.</p>
          <button class="button small" type="button" :disabled="!selected.length || saving || busy" @click="save">{{ saving ? 'Remembering…' : 'Remember selected corrections' }}</button>
        </template>
      </template>
      <button class="text-button" type="button" :disabled="saving" @click="editing = false">Cancel correction</button>
    </section>
    <p v-if="message" :class="{ 'field-error': failed }" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Correction, Transcript } from '../../shared/types'
import { suggestCorrections } from '../../shared/corrections'

const props = defineProps<{ transcript: Transcript; enabled: boolean; busy: boolean }>()
const editing = ref(false), corrected = ref(''), reviewed = ref(false), saving = ref(false)
const suggestions = ref<Correction[]>([]), selected = ref<number[]>([])
const message = ref(''), failed = ref(false)
let sourceText = '', sourceId = 0
function begin(): void {
  sourceText = props.transcript.text; sourceId = props.transcript.createdAt
  corrected.value = sourceText; editing.value = true; reviewed.value = false; message.value = ''
}
function review(): void {
  suggestions.value = suggestCorrections(sourceText, corrected.value)
  selected.value = suggestions.value.map((_, index) => index)
  reviewed.value = true; message.value = ''
}
async function save(): Promise<void> {
  saving.value = true; message.value = ''; failed.value = false
  try {
    const rules = suggestions.value.filter((_, index) => selected.value.includes(index)).map(rule => ({ from: rule.from, to: rule.to }))
    await window.terry.learnCorrections(sourceId, corrected.value, rules)
    editing.value = false
    message.value = 'Remembered locally. Use Copy transcript if you also want the corrected text now.'
  } catch (error) {
    failed.value = true; message.value = error instanceof Error ? error.message : 'Corrections could not be saved.'
  } finally { saving.value = false }
}
watch(() => props.transcript.createdAt, () => { editing.value = false; message.value = '' })
</script>
