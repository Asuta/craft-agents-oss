import { describe, it, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configDir: string

function writeConfig(config: unknown) {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config), 'utf-8')
}

describe('API profiles (config storage)', () => {
  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), 'craft-agent-test-config-'))
    process.env.CRAFT_CONFIG_DIR = configDir
  })

  afterAll(() => {
    try {
      rmSync(configDir, { recursive: true, force: true })
    } catch {
    }
  })

  it('creates default profile when missing', async () => {
    writeConfig({
      authType: 'api_key',
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    })

    const storage = await import('../src/config/storage.ts')
    const profiles = storage.getApiProfiles()
    expect(profiles.length).toBe(1)
    expect(profiles[0]?.id).toBe('default')
    expect(storage.getActiveApiProfileId()).toBe('default')
  })

  it('switches active profile and preserves per-profile settings', async () => {
    const storage = await import('../src/config/storage.ts')

    writeConfig({
      authType: 'api_key',
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      apiProfiles: [
        {
          id: 'default',
          name: 'Default',
          authType: 'api_key',
          anthropicBaseUrl: 'https://api.anthropic.com',
        },
        {
          id: 'p2',
          name: 'OpenRouter',
          authType: 'api_key',
          anthropicBaseUrl: 'https://openrouter.ai/api',
          customModel: 'openai/gpt-4o-mini',
        },
      ],
      activeApiProfileId: 'default',
    })

    expect(storage.getActiveApiProfileId()).toBe('default')
    expect(storage.setActiveApiProfile('p2')).toBe(true)
    expect(storage.getActiveApiProfileId()).toBe('p2')
    expect(storage.getAnthropicBaseUrl()).toBe('https://openrouter.ai/api')
    expect(storage.getCustomModel()).toBe('openai/gpt-4o-mini')
  })

  it('creates, renames, and deletes profiles', async () => {
    const storage = await import('../src/config/storage.ts')

    writeConfig({
      authType: 'api_key',
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      apiProfiles: [
        {
          id: 'default',
          name: 'Default',
          authType: 'api_key',
          anthropicBaseUrl: 'https://openrouter.ai/api',
          customModel: 'openai/gpt-4o-mini',
        },
      ],
      activeApiProfileId: 'default',
    })

    const created = storage.createApiProfile('New Profile', true)
    expect(created).toBeTruthy()
    expect(created?.name).toBe('New Profile')
    expect(created?.anthropicBaseUrl).toBe('https://openrouter.ai/api')
    expect(created?.customModel).toBe('openai/gpt-4o-mini')

    expect(storage.renameApiProfile(created!.id, 'Renamed')).toBe(true)
    const renamed = storage.getApiProfiles().find(p => p.id === created!.id)
    expect(renamed?.name).toBe('Renamed')

    expect(storage.deleteApiProfile('does-not-exist')).toBe(false)
    expect(storage.deleteApiProfile(created!.id)).toBe(true)

    const remaining = storage.getApiProfiles()
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.id).toBe('default')
  })

  it('prevents deleting the last remaining profile', async () => {
    const storage = await import('../src/config/storage.ts')

    writeConfig({
      authType: 'api_key',
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      apiProfiles: [{ id: 'default', name: 'Default', authType: 'api_key' }],
      activeApiProfileId: 'default',
    })

    expect(storage.deleteApiProfile('default')).toBe(false)
    expect(storage.getApiProfiles().length).toBe(1)
  })
})

