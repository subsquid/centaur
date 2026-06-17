module Console
  # Self-service "my provider keys" page: a logged-in user registers their own
  # Anthropic / OpenAI API key. Each key is stored as a `replace` StaticSecret
  # (inline control_plane value = the real key) scoped to the provider host and
  # granted to the user's session-scoped personal principal, mirroring the
  # built-in api_key harness fragment (see ProviderKey). A user's Slack /
  # third-party sessions then run as that principal and iron-proxy swaps the
  # placeholder for the real key -- billing the user, not a shared key.
  #
  # The key is WRITE-ONLY: it is never rendered back. Following the
  # BrokerCredential pattern, a blank field on save leaves the stored key in
  # place; a non-blank field (re)sets it. Unlike base_secrets (which re-renders
  # stored control_plane values), nothing here echoes the secret.
  class ProviderKeysController < ApplicationController
    layout "console"

    before_action :set_provider, only: %i[update destroy]

    # GET /console/provider_keys
    def show
      load_state
    end

    # PATCH /console/provider_keys/:provider
    def update
      key = params[:key].to_s
      @secret = upsert_provider_secret(@provider, key)

      if @secret.persisted? && @secret.errors.empty?
        redirect_to console_provider_keys_path, notice: "#{@provider[:label]} key saved."
      else
        flash.now[:alert] = @secret.errors.full_messages.to_sentence.presence ||
                            "Could not save the #{@provider[:label]} key."
        load_state
        render :show, status: :unprocessable_entity
      end
    end

    # DELETE /console/provider_keys/:provider
    #
    # Destroying the static_secret cascades to its grant, source, and rules
    # (dependent: :destroy), so the user's session falls back to "no key" and the
    # bot prompts onboarding again.
    def destroy
      find_provider_secret(@provider)&.destroy
      redirect_to console_provider_keys_path, notice: "#{@provider[:label]} key removed."
    end

    private

    def set_provider
      @provider = ProviderKey.fetch(params[:provider])
      return if @provider
      redirect_to console_provider_keys_path, alert: "Unknown provider."
    end

    # The page's view model: the current user's configured providers, each mapped
    # to its existing StaticSecret (or nil when not yet registered).
    def load_state
      @providers = ProviderKey.slugs.map { |slug| ProviderKey.fetch(slug) }
      @secrets = @providers.index_with { |provider| find_provider_secret(provider) }
    end

    # The StaticSecret backing one provider's key for this user, if registered.
    def find_provider_secret(provider)
      StaticSecret.find_by(namespace: User::PERSONAL_PRINCIPAL_NAMESPACE,
                           foreign_id: provider_foreign_id(provider))
    end

    def provider_foreign_id(provider)
      "#{current_user.personal_principal_foreign_id}-#{provider[:slug]}"
    end

    # Create or update the provider-key StaticSecret + its grant to the user's
    # personal principal. Returns the secret (persisted on success; carrying
    # errors on failure). The key is write-only: only assigned when non-blank.
    def upsert_provider_secret(provider, key)
      secret = StaticSecret.find_or_initialize_by(
        namespace: User::PERSONAL_PRINCIPAL_NAMESPACE,
        foreign_id: provider_foreign_id(provider)
      )

      if secret.new_record?
        if key.blank?
          secret.errors.add(:base, "Enter your #{provider[:label]} API key.")
          return secret
        end
        secret.created_by = current_user
      end

      secret.name = "#{provider[:label]} API key (#{current_user.email})"
      secret.description = "BYO #{provider[:label]} key for #{current_user.email}"
      secret.inject_config = nil
      secret.replace_config = {
        "proxy_value" => provider[:env],
        "match_headers" => provider[:match_headers]
      }
      # Write-only key: only (re)attach the inline value when a new key was
      # entered; a blank field keeps the stored one. Assigning a fresh has_one
      # source replaces the old one (dependent: :destroy) and autosaves the new --
      # mirroring base_secrets. (Mutating an existing source in place wouldn't
      # autosave, and reassigning its readonly source_type would raise.)
      secret.source = SecretSource.new(source_type: "control_plane", secret: key) if key.present?
      # Scope the swap to the provider host (mirrors the harness fragment's rule).
      secret.rules = [ RequestRule.new(host: provider[:host], position: 0) ]

      persist(secret)
      secret
    end

    # Save the secret and ensure the grant to the personal principal, atomically.
    # A failed save leaves errors on the secret; a failed grant rolls back both.
    def persist(secret)
      ActiveRecord::Base.transaction do
        secret.save!
        Grant.find_or_create_by!(principal: current_user.personal_principal, static_secret: secret) do |grant|
          grant.created_by = current_user
        end
      end
    rescue ActiveRecord::RecordInvalid
      # Validation messages are already on `secret` (or its nested source/rules);
      # the action surfaces them. Swallow so the form re-renders 422 rather than 500.
      nil
    end
  end
end
