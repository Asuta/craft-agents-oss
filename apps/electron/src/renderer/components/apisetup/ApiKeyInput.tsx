/**
 * ApiKeyInput - Reusable API key entry form control
 *
 * Renders a password input for the API key, a preset selector for Base URL,
 * and an optional Model override field.
 *
 * Does NOT include layout wrappers or action buttons — the parent
 * controls placement via the form ID ("api-key-form") for submit binding.
 *
 * Used in: Onboarding CredentialsStep, Settings API dialog
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { RenameDialog } from "@/components/ui/rename-dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-dropdown"
import { cn } from "@/lib/utils"
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react"
import { SettingsMenuSelect, type SettingsMenuSelectOption } from "@/components/settings"
import type { ApiProfilesInfo, ApiSetupInfo } from "../../../shared/types"

export type ApiKeyStatus = 'idle' | 'validating' | 'success' | 'error'

export interface ApiKeySubmitData {
  apiKey: string
  baseUrl?: string
  customModel?: string
}

export interface ApiKeyInputProps {
  /** Current validation status */
  status: ApiKeyStatus
  /** Error message to display when status is 'error' */
  errorMessage?: string
  /** Called when the form is submitted with the key and optional endpoint config */
  onSubmit: (data: ApiKeySubmitData) => void
  /** Form ID for external submit button binding (default: "api-key-form") */
  formId?: string
  /** Disable the input (e.g. during validation) */
  disabled?: boolean
}

type PresetKey = 'anthropic' | 'openrouter' | 'vercel' | 'ollama' | 'gemini' | 'custom'

interface Preset {
  key: PresetKey
  label: string
  url: string
}

const PRESETS: Preset[] = [
  { key: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com' },
  { key: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api' },
  { key: 'vercel', label: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh' },
  { key: 'gemini', label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta' },
  { key: 'ollama', label: 'Ollama', url: 'http://localhost:11434' },
  { key: 'custom', label: 'Custom', url: '' },
]

function getPresetForUrl(url: string): PresetKey {
  const match = PRESETS.find(p => p.key !== 'custom' && p.url === url)
  return match?.key ?? 'custom'
}

export function ApiKeyInput({
  status,
  errorMessage,
  onSubmit,
  formId = "api-key-form",
  disabled,
}: ApiKeyInputProps) {
  const [apiProfiles, setApiProfiles] = useState<ApiProfilesInfo | null>(null)
  const [activeProfileId, setActiveProfileId] = useState<string>('')
  const [isProfileLoading, setIsProfileLoading] = useState(false)
  const [isCreateProfileOpen, setIsCreateProfileOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')

  const [apiKey, setApiKey] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].url)
  const [activePreset, setActivePreset] = useState<PresetKey>('anthropic')
  const [customModel, setCustomModel] = useState('')

  const isDisabled = disabled || status === 'validating'

  const profileOptions: SettingsMenuSelectOption[] = useMemo(() => {
    return (apiProfiles?.profiles ?? []).map((p) => ({
      value: p.id,
      label: p.name,
      description: p.authType === 'oauth_token' ? 'Claude OAuth' : 'API Key',
    }))
  }, [apiProfiles])

  const applySetupToForm = useCallback((setup: ApiSetupInfo) => {
    const nextBaseUrl = setup.anthropicBaseUrl ?? PRESETS[0].url
    setBaseUrl(nextBaseUrl)
    setActivePreset(getPresetForUrl(nextBaseUrl))
    setCustomModel(setup.customModel ?? '')
    setApiKey(setup.apiKey ?? '')
  }, [])

  const reloadFromBackend = useCallback(async () => {
    if (!window.electronAPI?.getApiProfiles || !window.electronAPI?.getApiSetup) return

    const [profiles, setup] = await Promise.all([
      window.electronAPI.getApiProfiles(),
      window.electronAPI.getApiSetup(),
    ])

    setApiProfiles(profiles)
    const nextActiveId = profiles.activeId ?? profiles.profiles[0]?.id ?? ''
    setActiveProfileId(nextActiveId)
    applySetupToForm(setup)
  }, [applySetupToForm])

  useEffect(() => {
    const run = async () => {
      if (!window.electronAPI?.getApiProfiles || !window.electronAPI?.getApiSetup) return
      setIsProfileLoading(true)
      try {
        await reloadFromBackend()
      } finally {
        setIsProfileLoading(false)
      }
    }
    void run()
  }, [reloadFromBackend])

  const handleProfileChange = useCallback(async (profileId: string) => {
    if (!window.electronAPI?.setActiveApiProfile) return
    setIsProfileLoading(true)
    try {
      await window.electronAPI.setActiveApiProfile(profileId)
      await reloadFromBackend()
    } finally {
      setIsProfileLoading(false)
    }
  }, [reloadFromBackend])

  const handleCreateProfile = useCallback(async () => {
    if (!window.electronAPI?.createApiProfile) return
    const name = newProfileName.trim()
    if (!name) return

    setIsProfileLoading(true)
    try {
      await window.electronAPI.createApiProfile(name, true)
      setIsCreateProfileOpen(false)
      setNewProfileName('')
      await reloadFromBackend()
    } finally {
      setIsProfileLoading(false)
    }
  }, [newProfileName, reloadFromBackend])

  const handlePresetSelect = (preset: Preset) => {
    setActivePreset(preset.key)
    if (preset.key === 'custom') {
      setBaseUrl('')
    } else {
      setBaseUrl(preset.url)
    }
    // Pre-fill recommended model for Ollama and Gemini; clear for all others
    // (Anthropic hides the field entirely, others default to Claude model IDs when empty)
    if (preset.key === 'ollama') {
      setCustomModel('qwen3-coder')
    } else if (preset.key === 'gemini') {
      setCustomModel('models/gemini-2.0-flash')
    } else {
      setCustomModel('')
    }
  }

  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value)
    setActivePreset(getPresetForUrl(value))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Always call onSubmit — the hook decides whether an empty key is valid
    // (custom endpoints like Ollama don't require API keys)
    const effectiveBaseUrl = baseUrl.trim()
    const isDefault = effectiveBaseUrl === PRESETS[0].url || !effectiveBaseUrl
    onSubmit({
      apiKey: apiKey.trim(),
      baseUrl: isDefault ? undefined : effectiveBaseUrl,
      customModel: customModel.trim() || undefined,
    })
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-6">
      {!!profileOptions.length && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Profile</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsCreateProfileOpen(true)}
              disabled={isDisabled || isProfileLoading}
            >
              New
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <SettingsMenuSelect
              value={activeProfileId}
              onValueChange={handleProfileChange}
              options={profileOptions}
              disabled={isDisabled || isProfileLoading}
              menuWidth={320}
              className="w-full justify-between"
            />
          </div>
        </div>
      )}

      {/* API Key */}
      <div className="space-y-2">
        <Label htmlFor="api-key">API Key</Label>
        <div className={cn(
          "relative rounded-md shadow-minimal transition-colors",
          "bg-foreground-2 focus-within:bg-background"
        )}>
          <Input
            id="api-key"
            type={showValue ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            className={cn(
              "pr-10 border-0 bg-transparent shadow-none",
              status === 'error' && "focus-visible:ring-destructive"
            )}
            disabled={isDisabled}
            autoFocus
          />
          <button
            type="button"
            onClick={() => setShowValue(!showValue)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {showValue ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        </div>
      </div>

      {/* Base URL with Preset Dropdown */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="base-url">Base URL</Label>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={isDisabled}
              className="flex h-6 items-center gap-1 rounded-[6px] bg-background shadow-minimal pl-2.5 pr-2 text-[12px] font-medium text-foreground/50 hover:bg-foreground/5 hover:text-foreground focus:outline-none"
            >
              {PRESETS.find(p => p.key === activePreset)?.label}
              <ChevronDown className="size-2.5 opacity-50" />
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end" className="z-floating-menu">
              {PRESETS.map((preset) => (
                <StyledDropdownMenuItem
                  key={preset.key}
                  onClick={() => handlePresetSelect(preset)}
                  className="justify-between"
                >
                  {preset.label}
                  <Check className={cn("size-3", activePreset === preset.key ? "opacity-100" : "opacity-0")} />
                </StyledDropdownMenuItem>
              ))}
            </StyledDropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className={cn(
          "rounded-md shadow-minimal transition-colors",
          "bg-foreground-2 focus-within:bg-background"
        )}>
          <Input
            id="base-url"
            type="text"
            value={baseUrl}
            onChange={(e) => handleBaseUrlChange(e.target.value)}
            placeholder="https://your-api-endpoint.com"
            className="border-0 bg-transparent shadow-none"
            disabled={isDisabled}
          />
        </div>
      </div>

      {/* Custom Model (optional) — hidden for Anthropic since it uses its own model routing */}
      {activePreset !== 'anthropic' && (
        <div className="space-y-2">
          <Label htmlFor="custom-model" className="text-muted-foreground font-normal">
            Model <span className="text-foreground/30">· optional</span>
          </Label>
          <div className={cn(
            "rounded-md shadow-minimal transition-colors",
            "bg-foreground-2 focus-within:bg-background"
          )}>
            <Input
              id="custom-model"
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. openai/gpt-5, qwen3-coder"
              className="border-0 bg-transparent shadow-none"
              disabled={isDisabled}
            />
          </div>
          {/* Contextual help links for providers that need model format guidance */}
          {activePreset === 'openrouter' && (
            <p className="text-xs text-foreground/30">
              Leave empty for Claude models. Only set for non-Claude models.
              <br />
              Format: <code className="text-foreground/40">provider/model-name</code>.{' '}
              <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-foreground/50 underline hover:text-foreground/70">
                Browse models
              </a>
            </p>
          )}
          {activePreset === 'vercel' && (
            <p className="text-xs text-foreground/30">
              Leave empty for Claude models. Only set for non-Claude models.
              <br />
              Format: <code className="text-foreground/40">provider/model-name</code>.{' '}
              <a href="https://vercel.com/docs/ai-gateway" target="_blank" rel="noopener noreferrer" className="text-foreground/50 underline hover:text-foreground/70">
                View supported models
              </a>
            </p>
          )}
          {activePreset === 'ollama' && (
            <p className="text-xs text-foreground/30">
              Use any model pulled via <code className="text-foreground/40">ollama pull</code>. No API key required.
            </p>
          )}
          {activePreset === 'gemini' && (
            <p className="text-xs text-foreground/30">
              Use Google AI Studio model IDs.
              <br />
              Format: <code className="text-foreground/40">models/gemini-*</code>
            </p>
          )}
          {(activePreset === 'custom' || !activePreset) && (
            <p className="text-xs text-foreground/30">
              Defaults to Anthropic model names (Opus, Sonnet, Haiku) when empty
            </p>
          )}
        </div>
      )}

      {/* Error message */}
      {status === 'error' && errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}

      <RenameDialog
        open={isCreateProfileOpen}
        onOpenChange={setIsCreateProfileOpen}
        title="New API Profile"
        value={newProfileName}
        onValueChange={setNewProfileName}
        onSubmit={handleCreateProfile}
        placeholder="Profile name"
      />
    </form>
  )
}
