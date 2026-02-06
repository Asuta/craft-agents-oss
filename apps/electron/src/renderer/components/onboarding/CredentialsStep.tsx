/**
 * CredentialsStep - Onboarding step wrapper for API key or OAuth flow
 *
 * Thin wrapper that composes ApiKeyInput or OAuthConnect controls
 * with StepFormLayout for the onboarding wizard context.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { ExternalLink } from "lucide-react"
import type { ApiSetupMethod } from "./APISetupStep"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import {
  ApiKeyInput,
  type ApiKeyStatus,
  type ApiKeySubmitData,
  OAuthConnect,
  type OAuthStatus,
} from "../apisetup"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RenameDialog } from "@/components/ui/rename-dialog"
import { SettingsMenuSelect, type SettingsMenuSelectOption } from "@/components/settings"
import type { ApiProfilesInfo } from "../../../shared/types"

export type CredentialStatus = ApiKeyStatus | OAuthStatus

interface CredentialsStepProps {
  apiSetupMethod: ApiSetupMethod
  status: CredentialStatus
  errorMessage?: string
  onSubmit: (data: ApiKeySubmitData) => void
  onStartOAuth?: () => void
  onBack: () => void
  // Two-step OAuth flow
  isWaitingForCode?: boolean
  onSubmitAuthCode?: (code: string) => void
  onCancelOAuth?: () => void
}

export function CredentialsStep({
  apiSetupMethod,
  status,
  errorMessage,
  onSubmit,
  onStartOAuth,
  onBack,
  isWaitingForCode,
  onSubmitAuthCode,
  onCancelOAuth,
}: CredentialsStepProps) {
  const isOAuth = apiSetupMethod === 'claude_oauth'

  const [apiProfiles, setApiProfiles] = useState<ApiProfilesInfo | null>(null)
  const [activeProfileId, setActiveProfileId] = useState<string>('')
  const [isProfileLoading, setIsProfileLoading] = useState(false)
  const [isCreateProfileOpen, setIsCreateProfileOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')

  const isDisabled = status === 'validating'

  const profileOptions: SettingsMenuSelectOption[] = useMemo(() => {
    return (apiProfiles?.profiles ?? []).map((p) => ({
      value: p.id,
      label: p.name,
      description: p.authType === 'oauth_token' ? 'Claude OAuth' : 'API Key',
    }))
  }, [apiProfiles])

  const reloadProfiles = useCallback(async () => {
    if (!window.electronAPI?.getApiProfiles) return
    const profiles = await window.electronAPI.getApiProfiles()
    setApiProfiles(profiles)
    setActiveProfileId(profiles.activeId ?? profiles.profiles[0]?.id ?? '')
  }, [])

  useEffect(() => {
    if (!isOAuth) return
    void reloadProfiles()
  }, [isOAuth, reloadProfiles])

  const handleSelectProfile = useCallback(async (profileId: string) => {
    if (!window.electronAPI?.setActiveApiProfile) return
    setIsProfileLoading(true)
    try {
      const ok = await window.electronAPI.setActiveApiProfile(profileId)
      if (ok) {
        setActiveProfileId(profileId)
        await reloadProfiles()
      }
    } finally {
      setIsProfileLoading(false)
    }
  }, [reloadProfiles])

  const handleCreateProfile = useCallback(async () => {
    if (!window.electronAPI?.createApiProfile) return
    const name = newProfileName.trim()
    setNewProfileName('')
    setIsCreateProfileOpen(false)
    if (!name) return
    setIsProfileLoading(true)
    try {
      const created = await window.electronAPI.createApiProfile(name)
      if (created) {
        setActiveProfileId(created.id)
        await reloadProfiles()
      }
    } finally {
      setIsProfileLoading(false)
    }
  }, [newProfileName, reloadProfiles])

  // --- OAuth flow ---
  if (isOAuth) {
    // Waiting for authorization code entry
    if (isWaitingForCode) {
      return (
        <StepFormLayout
          title="Enter Authorization Code"
          description="Copy the code from the browser page and paste it below."
          actions={
            <>
              <BackButton onClick={onCancelOAuth} disabled={status === 'validating'}>Cancel</BackButton>
              <ContinueButton
                type="submit"
                form="auth-code-form"
                disabled={false}
                loading={status === 'validating'}
                loadingText="Connecting..."
              />
            </>
          }
        >
          <OAuthConnect
            status={status as OAuthStatus}
            errorMessage={errorMessage}
            isWaitingForCode={true}
            onStartOAuth={onStartOAuth!}
            onSubmitAuthCode={onSubmitAuthCode}
            onCancelOAuth={onCancelOAuth}
          />
        </StepFormLayout>
      )
    }

    const showProfileControls = (apiProfiles?.profiles?.length ?? 0) > 0

    return (
      <StepFormLayout
        title="Connect Claude Account"
        description="Use your Claude subscription to power multi-agent workflows."
        actions={
          <>
            <BackButton onClick={onBack} disabled={status === 'validating'} />
            <ContinueButton
              onClick={onStartOAuth}
              className="gap-2"
              loading={status === 'validating'}
              loadingText="Connecting..."
            >
              <ExternalLink className="size-4" />
              Sign in with Claude
            </ContinueButton>
          </>
        }
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>API Profile</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isDisabled || isProfileLoading || !window.electronAPI?.createApiProfile}
              onClick={() => setIsCreateProfileOpen(true)}
            >
              New
            </Button>
          </div>
          <SettingsMenuSelect
            value={activeProfileId}
            onValueChange={handleSelectProfile}
            options={profileOptions}
            placeholder={showProfileControls ? "Select a profile" : "Default"}
            disabled={isDisabled || isProfileLoading || !showProfileControls}
          />
        </div>

        <OAuthConnect
          status={status as OAuthStatus}
          errorMessage={errorMessage}
          isWaitingForCode={false}
          onStartOAuth={onStartOAuth!}
          onSubmitAuthCode={onSubmitAuthCode}
          onCancelOAuth={onCancelOAuth}
        />

        <RenameDialog
          open={isCreateProfileOpen}
          onOpenChange={setIsCreateProfileOpen}
          title="New API Profile"
          description="Create a new API configuration profile."
          placeholder="Profile name"
          value={newProfileName}
          onChange={setNewProfileName}
          onSubmit={handleCreateProfile}
          disabled={isDisabled || isProfileLoading}
        />
      </StepFormLayout>
    )
  }

  // --- API Key flow ---
  return (
    <StepFormLayout
      title="API Configuration"
      description="Enter your API key. Optionally configure a custom endpoint for OpenRouter, Ollama, or compatible APIs."
      actions={
        <>
          <BackButton onClick={onBack} disabled={status === 'validating'} />
          <ContinueButton
            type="submit"
            form="api-key-form"
            disabled={false}
            loading={status === 'validating'}
            loadingText="Validating..."
          />
        </>
      }
    >
      <ApiKeyInput
        status={status as ApiKeyStatus}
        errorMessage={errorMessage}
        onSubmit={onSubmit}
      />
    </StepFormLayout>
  )
}
