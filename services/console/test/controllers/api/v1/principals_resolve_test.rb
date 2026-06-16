require "test_helper"

module Api
  module V1
    # GET /api/v1/principals/resolve_slack -- the lookup slackbotv2 uses to map a
    # thread owner (by verified Slack email) to the principal their sessions run
    # as, and to learn whether they have a provider key yet.
    class PrincipalsResolveTest < ActionDispatch::IntegrationTest
      ACME_TOKEN = "iak_acme-ci-token".freeze

      def auth_headers(token = ACME_TOKEN)
        { "Authorization" => "Bearer #{token}", "Content-Type" => "application/json" }
      end

      def json_body
        JSON.parse(response.body)
      end

      test "rejects unauthenticated requests" do
        get resolve_slack_api_v1_principals_url, params: { email: "admin@acme.example" }
        assert_response :unauthorized
      end

      test "resolves a user by email to their personal principal foreign_id" do
        user = users(:member_user)
        get resolve_slack_api_v1_principals_url, params: { email: user.email }, headers: auth_headers
        assert_response :ok

        data = json_body.fetch("data")
        assert_equal user.oid, data["user_id"]
        assert_equal "user-#{user.id}", data["principal_foreign_id"]
        assert_equal false, data["has_provider_key"]
        assert_equal "no-store", response.headers["Cache-Control"]
      end

      test "email lookup is case-insensitive and trimmed" do
        user = users(:member_user)
        get resolve_slack_api_v1_principals_url,
            params: { email: "  #{user.email.upcase}  " }, headers: auth_headers
        assert_response :ok
        assert_equal user.oid, json_body.dig("data", "user_id")
      end

      test "reports has_provider_key true once a provider key is granted" do
        user = users(:member_user)
        register_anthropic_key(user, "sk-ant-secret")

        get resolve_slack_api_v1_principals_url, params: { email: user.email }, headers: auth_headers
        assert_response :ok
        assert_equal true, json_body.dig("data", "has_provider_key")
      end

      test "is read-only: does not create the personal principal" do
        user = users(:member_user)
        assert_nil user.existing_personal_principal
        assert_no_difference -> { Principal.count } do
          get resolve_slack_api_v1_principals_url, params: { email: user.email }, headers: auth_headers
        end
        assert_response :ok
        assert_nil user.existing_personal_principal
      end

      test "returns 404 for an unknown email" do
        get resolve_slack_api_v1_principals_url,
            params: { email: "nobody@nowhere.example" }, headers: auth_headers
        assert_response :not_found
      end

      test "returns 400 when email is missing" do
        get resolve_slack_api_v1_principals_url, headers: auth_headers
        assert_response :bad_request
      end

      private

      def register_anthropic_key(user, key)
        principal = user.personal_principal
        secret = StaticSecret.create!(
          namespace: User::PERSONAL_PRINCIPAL_NAMESPACE, foreign_id: "user-#{user.id}-anthropic",
          replace_config: { "proxy_value" => "ANTHROPIC_API_KEY", "match_headers" => %w[X-Api-Key] },
          created_by: user
        )
        SecretSource.create!(source_type: "control_plane", secret: key, static_secret: secret)
        Grant.create!(principal: principal, static_secret: secret, created_by: user)
      end
    end
  end
end
