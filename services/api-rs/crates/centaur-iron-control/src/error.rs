use thiserror::Error;

/// Errors returned by the iron-control admin client.
#[derive(Debug, Error)]
pub enum IronControlError {
    /// The HTTP request could not be sent or the response could not be read.
    #[error("iron-control request to {path} failed: {source}")]
    Transport {
        path: String,
        #[source]
        source: reqwest::Error,
    },
    /// iron-control returned a non-success status. ``body`` is the raw response
    /// text, which carries iron-control's ``{ "error": { "message", "details" } }``
    /// envelope for 4xx validation failures.
    #[error("iron-control {method} {path} returned {status}: {body}")]
    Status {
        method: String,
        path: String,
        status: u16,
        body: String,
    },
    /// A 2xx response body did not deserialize into the expected shape.
    #[error("iron-control {path} response did not match the expected schema: {source}")]
    Decode {
        path: String,
        #[source]
        source: reqwest::Error,
    },
    /// A caller supplied an explicit principal foreign_id that isn't a valid
    /// URL-safe slug, so it can't be registered. Rejected rather than silently
    /// falling back to a thread-derived principal (which would run the session
    /// under the wrong identity / key).
    #[error("invalid principal foreign_id {foreign_id:?}: must be URL-safe (A-Za-z0-9-._~)")]
    InvalidPrincipalForeignId { foreign_id: String },
}

pub type Result<T> = std::result::Result<T, IronControlError>;
