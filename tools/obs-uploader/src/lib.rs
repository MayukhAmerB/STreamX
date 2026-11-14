//! OBS recording uploader: watches for finished OBS recordings and uploads each
//! one to its class on the Al Syed platform, resumably, through the
//! `/api/recording-uploads/` API with a personal upload token.

pub mod api;
pub mod app;
pub mod config;
pub mod log;
pub mod obs;
pub mod state;
pub mod upload;
pub mod watch;
