//! Per-session principal registration.
//!
//! Roles are registered once at startup (see [`crate::register_role`]); a
//! [`SessionRegistrar`] carries the resulting role OIDs and, when a session
//! starts, upserts the session's principal and assigns it those roles. The
//! principal is derived from the thread key (see [`crate::derive_principal`]).

use crate::IronControlClient;
use crate::error::Result;
use crate::models::Principal;
use crate::principal::{PrincipalRef, derive_principal};

/// Registers a session's principal against iron-control at session start.
///
/// Cheap to clone (the inner [`IronControlClient`] shares a connection pool),
/// so it can live on a shared runtime handle.
#[derive(Clone, Debug)]
pub struct SessionRegistrar {
    client: IronControlClient,
    namespace: String,
    assign_role_ids: Vec<String>,
}

impl SessionRegistrar {
    /// ``assign_role_ids`` are the iron-control role OIDs (from
    /// [`crate::register_role`]) to assign to every session's principal.
    pub fn new(
        client: IronControlClient,
        namespace: impl Into<String>,
        assign_role_ids: Vec<String>,
    ) -> Self {
        Self {
            client,
            namespace: namespace.into(),
            assign_role_ids,
        }
    }

    /// Upsert the thread-derived principal and grant it the configured infra
    /// role (the legacy path for threads with no explicit owner). ``slack_user_id``
    /// keys a 1:1 DM principal; it is ignored for channel threads.
    /// ``conversation_name`` is the human-readable channel/DM name (when the
    /// slackbot resolved one) used as the principal's display name. Returns the
    /// upserted record (its ``id`` is the OID) so callers can bind the session's
    /// egress proxy to the same identity. Idempotent.
    pub async fn register_session(
        &self,
        thread_key: &str,
        slack_user_id: Option<&str>,
        conversation_name: Option<&str>,
    ) -> Result<Principal> {
        self.register_principal(
            &derive_principal(thread_key, slack_user_id, conversation_name),
            true,
        )
        .await
    }

    /// Upsert ``principal`` and, when ``assign_roles`` is set, grant it the
    /// configured infra role.
    ///
    /// The owner (explicit-principal) path passes ``assign_roles: false`` so a
    /// session-scoped principal stays **provider-key-only**: it resolves the
    /// owner's provider key and nothing else, capping the blast radius of
    /// untrusted thread context to "spend the owner's LLM key" (MULTITENANT
    /// Part 1a/2c). The harness still gets its placeholder env from the proxy
    /// fragments regardless of role, so the LLM call works under the owner's key.
    /// Idempotent.
    pub async fn register_principal(
        &self,
        principal: &PrincipalRef,
        assign_roles: bool,
    ) -> Result<Principal> {
        let record = self
            .client
            .upsert_principal(&principal.to_identity_input(&self.namespace))
            .await?;
        if assign_roles {
            for role_id in &self.assign_role_ids {
                self.client.assign_role(&record.id, role_id).await?;
            }
        }
        Ok(record)
    }
}
