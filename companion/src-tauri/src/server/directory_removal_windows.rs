use std::fs::File;
use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
use std::sync::{mpsc, Arc, Weak};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GetLastError, ERROR_CLASS_ALREADY_EXISTS, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Storage::FileSystem::{GetVolumePathNameW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::{LocalSource, STALLED_READ_TIMEOUT};

pub(super) struct RemovalWatch {
    window: usize,
    #[cfg(test)]
    volume: usize,
}

struct Context {
    source: Weak<LocalSource>,
    volume: Option<File>,
    notification: Option<HDEVNOTIFY>,
}

impl Context {
    fn release(&mut self) {
        if let Some(notification) = self.notification.take() {
            if unsafe { UnregisterDeviceNotification(notification) }.is_err() {
                log::warn!("Directory removal notification could not be released. Restart the companion before removing the drive.");
            }
        }
        self.volume.take();
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        self.release();
    }
}

unsafe extern "system" fn procedure(window: HWND, message: u32, parameter: WPARAM, data: LPARAM) -> LRESULT {
    if message == WM_NCCREATE {
        let creation = &*(data.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(window, GWLP_USERDATA, creation.lpCreateParams as isize);
    }
    let pointer = GetWindowLongPtrW(window, GWLP_USERDATA) as *mut Context;
    if message == WM_DEVICECHANGE && !pointer.is_null() && data.0 != 0 {
        let context = &mut *pointer;
        let header = &*(data.0 as *const DEV_BROADCAST_HDR);
        if header.dbch_devicetype == DBT_DEVTYP_HANDLE && header.dbch_size as usize >= size_of::<DEV_BROADCAST_HANDLE>() {
            let event = &*(data.0 as *const DEV_BROADCAST_HANDLE);
            let matches = context
                .volume
                .as_ref()
                .is_some_and(|volume| event.dbch_handle == HANDLE(volume.as_raw_handle()));
            if matches && parameter.0 as u32 == DBT_DEVICEQUERYREMOVE {
                let ready = context
                    .source
                    .upgrade()
                    .is_none_or(|source| source.pause_for_removal().unwrap_or(false));
                if !ready {
                    return LRESULT(BROADCAST_QUERY_DENY as isize);
                }
                context.release();
                return LRESULT(1);
            }
            if matches && parameter.0 as u32 == DBT_DEVICEREMOVECOMPLETE {
                if let Some(source) = context.source.upgrade() {
                    if source.release_media_handles().is_err() {
                        log::warn!("Directory handles could not be released after media removal. Restart the companion.");
                    }
                }
                context.release();
                return LRESULT(1);
            }
        }
    }
    if message == WM_DESTROY {
        PostQuitMessage(0);
        return LRESULT(0);
    }
    DefWindowProcW(window, message, parameter, data)
}

impl RemovalWatch {
    pub(super) fn new(source: &Arc<LocalSource>) -> std::io::Result<Self> {
        const VOLUME_PATH_UNITS: usize = 32768;
        let root = source.root_path.clone();
        let source = Arc::downgrade(source);
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new().name("directory-removal".into()).spawn(move || {
            let outcome = (|| -> std::io::Result<()> {
                let root: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
                let mut mount = vec![0u16; VOLUME_PATH_UNITS];
                unsafe { GetVolumePathNameW(PCWSTR(root.as_ptr()), &mut mount) }.map_err(std::io::Error::from)?;
                let end = mount
                    .iter()
                    .position(|unit| *unit == 0)
                    .ok_or_else(|| std::io::Error::other("Invalid removal volume path."))?;
                let mount = String::from_utf16(&mount[..end]).map_err(std::io::Error::other)?;
                let volume = std::fs::OpenOptions::new()
                    .access_mode(0)
                    .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
                    .open(format!("\\\\.\\{}", mount.trim_end_matches('\\')))?;
                let mut context = Box::new(Context {
                    source,
                    volume: Some(volume),
                    notification: None,
                });
                let instance = unsafe { GetModuleHandleW(None) }.map_err(std::io::Error::from)?;
                let class = WNDCLASSW {
                    lpfnWndProc: Some(procedure),
                    hInstance: instance.into(),
                    lpszClassName: w!("SambeeDirectoryRemoval"),
                    ..Default::default()
                };
                if unsafe { RegisterClassW(&class) } == 0 && unsafe { GetLastError() } != ERROR_CLASS_ALREADY_EXISTS {
                    return Err(std::io::Error::last_os_error());
                }
                let window = unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("SambeeDirectoryRemoval"),
                        w!(""),
                        WINDOW_STYLE::default(),
                        0,
                        0,
                        0,
                        0,
                        Some(HWND_MESSAGE),
                        None,
                        Some(instance.into()),
                        Some(std::ptr::from_mut(context.as_mut()).cast()),
                    )
                }
                .map_err(std::io::Error::from)?;
                let filter = DEV_BROADCAST_HANDLE {
                    dbch_size: size_of::<DEV_BROADCAST_HANDLE>() as u32,
                    dbch_devicetype: DBT_DEVTYP_HANDLE.0,
                    dbch_handle: HANDLE(
                        context
                            .volume
                            .as_ref()
                            .ok_or_else(|| std::io::Error::other("Removal volume handle is unavailable."))?
                            .as_raw_handle(),
                    ),
                    ..Default::default()
                };
                match unsafe {
                    RegisterDeviceNotificationW(HANDLE(window.0), std::ptr::from_ref(&filter).cast(), DEVICE_NOTIFY_WINDOW_HANDLE)
                } {
                    Ok(notification) => context.notification = Some(notification),
                    Err(error) => {
                        let _ = unsafe { DestroyWindow(window) };
                        return Err(error.into());
                    }
                }
                let volume = context
                    .volume
                    .as_ref()
                    .ok_or_else(|| std::io::Error::other("Removal volume handle is unavailable."))?
                    .as_raw_handle() as usize;
                if sender.send(Ok((window.0 as usize, volume))).is_err() {
                    let _ = unsafe { DestroyWindow(window) };
                    return Ok(());
                }
                let mut message = MSG::default();
                loop {
                    let result = unsafe { GetMessageW(&mut message, None, 0, 0) }.0;
                    if result <= 0 {
                        break;
                    }
                    let _ = unsafe { TranslateMessage(&message) };
                    unsafe { DispatchMessageW(&message) };
                }
                Ok(())
            })();
            if let Err(error) = outcome {
                let _ = sender.send(Err(error));
            }
        })?;
        let (window, _volume) = receiver
            .recv_timeout(STALLED_READ_TIMEOUT)
            .map_err(|_| std::io::Error::other("Directory removal monitoring did not start. Reopen the drive and retry."))??;
        Ok(Self {
            window,
            #[cfg(test)]
            volume: _volume,
        })
    }
}

impl Drop for RemovalWatch {
    fn drop(&mut self) {
        if unsafe { PostMessageW(Some(HWND(self.window as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_err() {
            log::warn!("Directory removal monitor did not close. Restart the companion before removing the drive.");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{lock, LocalDirectoryManager};
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn query_remove_message_releases_handles_and_retains_rows() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("retained")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root, manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        let monitor = RemovalWatch::new(&source).unwrap();
        let event = DEV_BROADCAST_HANDLE {
            dbch_size: size_of::<DEV_BROADCAST_HANDLE>() as u32,
            dbch_devicetype: DBT_DEVTYP_HANDLE.0,
            dbch_handle: HANDLE(monitor.volume as *mut _),
            ..Default::default()
        };
        let result = unsafe {
            SendMessageW(
                HWND(monitor.window as *mut _),
                WM_DEVICECHANGE,
                Some(WPARAM(DBT_DEVICEQUERYREMOVE as usize)),
                Some(LPARAM(std::ptr::from_ref(&event) as isize)),
            )
        };
        assert_eq!(result.0, 1);
        assert!(source.media_unavailable.load(Ordering::Acquire));
        assert!(lock(&source.root).unwrap().is_none());
        assert!(lock(&source.watcher).unwrap().is_none());
        let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
        assert_eq!(
            reader
                .search("retained", 5, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .directory_count,
            1
        );
    }
}
