//! Tauri commands for companion-side pairing approval.

use std::sync::Arc;

use log::info;
use tauri::{AppHandle, Emitter, State};

use crate::server::pairing::{PairingState, SETTINGS_STATUS_CHANGED_EVENT};

/// Mark a pending pairing as approved on the companion side.
#[tauri::command]
pub fn confirm_pending_pairing(pairing_state: State<'_, Arc<PairingState>>, pairing_id: String) -> Result<(), String> {
    let origin = pairing_state.get_pending_origin(&pairing_id);
    pairing_state.companion_confirm(&pairing_id)?;
    info!(
        "Browser origin approval confirmed from companion UI: pairing_id={}, origin={}",
        pairing_id,
        origin.as_deref().unwrap_or("unknown")
    );
    Ok(())
}

/// Reject and discard a pending pairing on the companion side.
#[tauri::command]
pub fn reject_pending_pairing(pairing_state: State<'_, Arc<PairingState>>, pairing_id: String) -> Result<(), String> {
    let origin = pairing_state.get_pending_origin(&pairing_id);
    pairing_state.companion_reject(&pairing_id);
    info!(
        "Browser origin approval rejected from companion UI: pairing_id={}, origin={}",
        pairing_id,
        origin.as_deref().unwrap_or("unknown")
    );
    Ok(())
}

/// Return all trusted browser origins that currently have local-drive access.
#[tauri::command]
pub fn get_paired_origins(pairing_state: State<'_, Arc<PairingState>>) -> Vec<String> {
    pairing_state.get_paired_origins()
}

/// Remove a previously trusted browser origin.
#[tauri::command]
pub fn unpair_origin(app: AppHandle, pairing_state: State<'_, Arc<PairingState>>, origin: String) -> Result<(), String> {
    pairing_state.unpair(&origin)?;
    let _ = app.emit(SETTINGS_STATUS_CHANGED_EVENT, ());
    info!("Trusted browser origin removed from companion preferences: {}", origin);
    Ok(())
}
