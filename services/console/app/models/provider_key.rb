# Catalog of the bring-your-own provider API keys a user can register for their
# own session-scoped principal (see User#personal_principal). Each entry is the
# console-side mirror of the built-in `api_key`-mode harness fragment in
# centaur-iron-proxy (`fragment.rs`): the user's real key is stored inline on a
# StaticSecret whose `replace` rule swaps the placeholder for the real value on
# the provider's host, exactly as the global fragment does:
#
#   anthropic -> replace ANTHROPIC_API_KEY in the X-Api-Key header on api.anthropic.com
#   openai    -> replace OPENAI_API_KEY in the Authorization header on api.openai.com
#
# The placeholder (`env`) is also the sandbox env var name the harness reads, so
# it must equal the fragment's `proxy_value`. iron-proxy injects the real key in
# place of that placeholder for requests matching the host rule.
module ProviderKey
  # slug:          stable identifier used in URLs and the static_secret foreign_id
  # env:           placeholder == iron-proxy `replace.proxy_value` == sandbox env var
  # host:          the only host the swap is scoped to (the replace rule)
  # match_headers: request headers the placeholder is searched/replaced in
  # label:         human label for the console UI
  CATALOG = {
    "anthropic" => {
      slug: "anthropic", env: "ANTHROPIC_API_KEY", host: "api.anthropic.com",
      match_headers: %w[X-Api-Key], label: "Anthropic"
    },
    "openai" => {
      slug: "openai", env: "OPENAI_API_KEY", host: "api.openai.com",
      match_headers: %w[Authorization], label: "OpenAI"
    }
  }.freeze

  # The placeholder names a session-scoped principal's grants are restricted to
  # (enforced in Grant): ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].
  PROXY_VALUES = CATALOG.values.map { |c| c[:env] }.freeze

  module_function

  # The provider config for a slug ("anthropic"/"openai"), or nil when unknown.
  def fetch(slug)
    CATALOG[slug.to_s]
  end

  def slugs
    CATALOG.keys
  end

  # Whether a replace rule's proxy_value is one of the managed provider keys.
  def proxy_value?(value)
    PROXY_VALUES.include?(value)
  end
end
