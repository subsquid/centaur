require "test_helper"

# The provider-key catalog and the StaticSecret predicate that drives the
# session-scoped principal invariant. The catalog must mirror the built-in
# api_key harness fragment (centaur-iron-proxy fragment.rs) exactly, or a
# per-user key won't be swapped the same way the global one is.
class ProviderKeyTest < ActiveSupport::TestCase
  test "anthropic maps to the X-Api-Key replace on api.anthropic.com" do
    p = ProviderKey.fetch("anthropic")
    assert_equal "ANTHROPIC_API_KEY", p[:env]
    assert_equal "api.anthropic.com", p[:host]
    assert_equal %w[X-Api-Key], p[:match_headers]
  end

  test "openai maps to the Authorization replace on api.openai.com" do
    p = ProviderKey.fetch("openai")
    assert_equal "OPENAI_API_KEY", p[:env]
    assert_equal "api.openai.com", p[:host]
    assert_equal %w[Authorization], p[:match_headers]
  end

  test "fetch returns nil for an unknown provider" do
    assert_nil ProviderKey.fetch("gemini")
    assert_nil ProviderKey.fetch(nil)
  end

  test "proxy_value? recognizes only the managed provider placeholders" do
    assert ProviderKey.proxy_value?("ANTHROPIC_API_KEY")
    assert ProviderKey.proxy_value?("OPENAI_API_KEY")
    assert_not ProviderKey.proxy_value?("GITHUB_TOKEN")
    assert_not ProviderKey.proxy_value?(nil)
  end

  test "StaticSecret#provider_key? is true for a managed replace placeholder" do
    assert StaticSecret.new(replace_config: { "proxy_value" => "ANTHROPIC_API_KEY" }).provider_key?
  end

  test "StaticSecret#provider_key? is false for other replace placeholders" do
    assert_not StaticSecret.new(replace_config: { "proxy_value" => "__DB_PASSWORD__" }).provider_key?
  end

  test "StaticSecret#provider_key? is false for an inject secret" do
    assert_not StaticSecret.new(inject_config: { "header" => "X-Api-Key" }).provider_key?
  end
end
