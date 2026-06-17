class User < ApplicationRecord
  oid_prefix "usr"

  # validations: false because SSO-only users have no password. The password
  # length rule below still applies to anyone who does set one (password login is
  # kept as a break-glass fallback).
  has_secure_password validations: false

  has_many :api_keys, dependent: :destroy
  has_many :user_identities, dependent: :destroy
  belongs_to :approved_by, class_name: "User", optional: true

  # pending: signed in via SSO but not yet approved -- cannot use the console.
  # active: approved operator. disabled: access revoked.
  enum :status, { pending: "pending", active: "active", disabled: "disabled" },
       default: :pending, validate: true

  normalizes :email, with: ->(e) { e.strip.downcase }

  validates :email,
            presence: true,
            uniqueness: true,
            format: { with: URI::MailTo::EMAIL_REGEXP }
  validates :password, length: { minimum: 12 }, allow_nil: true

  # Marks a pending user active, recording who approved them and when.
  def approve!(by:)
    update!(status: :active, approved_at: Time.current, approved_by: by)
  end

  # The namespace a user's personal principal lives in. Must match api-rs's
  # IRON_CONTROL_NAMESPACE (default "default"): slackbotv2/third-party callers
  # send only the foreign_id, and api-rs upserts/resolves the principal in its
  # own namespace, so the grant-bearing principal console creates here has to
  # share that namespace or the grant never binds.
  PERSONAL_PRINCIPAL_NAMESPACE = "default".freeze

  # The stable foreign_id of this user's personal principal. Derived from the
  # primary key (not #oid, which is a *computed* opaque id), so it is durable
  # across oid-encoding changes and never collides with another user's.
  def personal_principal_foreign_id
    "user-#{id}"
  end

  # Find-or-create this user's session-scoped personal principal: the
  # provider-key-only identity their Slack/third-party sessions run as. Idempotent.
  # Also (re)asserts session_scoped in case the row was first created by api-rs's
  # principal upsert (which doesn't set the flag) before the user registered a key.
  def personal_principal
    principal = Principal.find_or_create_by!(
      namespace: PERSONAL_PRINCIPAL_NAMESPACE,
      foreign_id: personal_principal_foreign_id
    ) do |p|
      p.created_by = self
      p.session_scoped = true
      p.name = "Personal principal (#{email})"
    end
    principal.update!(session_scoped: true) unless principal.session_scoped?
    principal
  end

  # This user's personal principal if it already exists, without creating one.
  # Used by the read-only resolve endpoint so a GET never writes.
  def existing_personal_principal
    Principal.find_by(namespace: PERSONAL_PRINCIPAL_NAMESPACE, foreign_id: personal_principal_foreign_id)
  end

  # Whether the user has registered at least one provider API key (a provider-key
  # static secret granted to their personal principal). Drives the bot's
  # run-vs-prompt-onboarding decision. Requires a deliverable source: a granted
  # secret with no (or a non-deliverable) source delivers no value to the proxy
  # (Principal#sync_secrets skips it), so it must not count as a registered key.
  def provider_key?
    principal = existing_personal_principal
    return false unless principal
    principal.granted_static_secrets.any? { |s| s.provider_key? && s.source&.deliverable? }
  end

  # Resolves the console user behind a verified SSO identity, creating or linking
  # as needed, and (re)caches the identity's email/name. A returning login matches
  # by the stable (provider, subject). A new identity links to an existing user
  # only when the IdP-verified email matches -- an unverified email must never
  # adopt an account -- otherwise a new user is created: active + admin when the
  # email is on the bootstrap allowlist, pending otherwise. +identity+ is the
  # provider strategy's { subject:, email:, email_verified:, name: } hash.
  def self.link_or_provision(provider:, identity:)
    transaction do
      if (existing = UserIdentity.find_by(provider: provider, subject: identity[:subject]))
        existing.update!(email: identity[:email], email_verified: identity[:email_verified])
        user = existing.user
        user.update!(name: identity[:name]) if identity[:name].present? && user.name.blank?
        next user
      end

      user = linkable_user(identity) || create!(provisioned_attributes(identity))
      user.user_identities.create!(
        provider: provider, subject: identity[:subject],
        email: identity[:email], email_verified: identity[:email_verified]
      )
      user
    end
  end

  # An existing user this identity may attach to: only when the IdP marked the
  # email verified (an unverified email must not adopt an existing account).
  def self.linkable_user(identity)
    return nil unless identity[:email_verified] && identity[:email].present?
    find_by(email: identity[:email].strip.downcase)
  end
  private_class_method :linkable_user

  # Attributes for a brand-new SSO user: active + admin when bootstrap-allowlisted
  # by a verified IdP email, pending otherwise.
  def self.provisioned_attributes(identity)
    admin = identity[:email_verified] == true && ConsoleAuth.bootstrap_admin?(identity[:email])
    { email: identity[:email], name: identity[:name], status: admin ? :active : :pending, admin: admin }
  end
  private_class_method :provisioned_attributes
end
