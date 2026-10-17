import { _electron } from '@playwright/test'

// UI/recognition tests use their own clipboard and software microphones. Real
// native insertion and rich pasteboard restoration are checked separately.
export const isolatedElectron = {
  async launch(options: Parameters<typeof _electron.launch>[0]) {
    const app = await _electron.launch(options)
    await app.evaluate(({ clipboard, systemPreferences }) => {
      let text = ''
      clipboard.writeText = async value => { text = value }
      clipboard.readText = async () => text
      systemPreferences.getMediaAccessStatus = () => 'granted'
    })
    return app
  }
}
