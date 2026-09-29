//! Top-level host windows that plugin editors embed into (X11 on Linux, Win32 on Windows, AppKit NSWindow on macOS).
#[derive(Debug, Clone, Copy)]
pub enum WinEvent { Close(u64), Resized(u64, u32, u32) }

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use super::WinEvent;
    use std::cell::RefCell;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::*;
    use x11rb::protocol::Event;
    use x11rb::rust_connection::RustConnection;
    use x11rb::wrapper::ConnectionExt as _;

    struct X { conn: RustConnection, screen: usize, wm_protocols: u32, wm_delete: u32, net_wm_name: u32, utf8: u32 }
    thread_local! { static XC: RefCell<Option<X>> = const { RefCell::new(None) }; }

    fn with_x<R>(f: impl FnOnce(&X) -> Result<R, String>) -> Result<R, String> {
        XC.with(|c| {
            let mut c = c.borrow_mut();
            if c.is_none() {
                let (conn, screen) = x11rb::connect(None).map_err(|e| format!("no display available for plugin windows ({e})"))?;
                let atom = |n: &str| -> Result<u32, String> { Ok(conn.intern_atom(false, n.as_bytes()).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?.atom) };
                let (wm_protocols, wm_delete, net_wm_name, utf8) = (atom("WM_PROTOCOLS")?, atom("WM_DELETE_WINDOW")?, atom("_NET_WM_NAME")?, atom("UTF8_STRING")?);
                *c = Some(X { conn, screen, wm_protocols, wm_delete, net_wm_name, utf8 });
            }
            f(c.as_ref().unwrap())
        })
    }
    pub fn available() -> bool { std::env::var_os("DISPLAY").is_some() }
    pub fn create(title: &str, w: u32, h: u32, resizable: bool) -> Result<u64, String> {
        with_x(|x| {
            let e = |e: &dyn std::fmt::Display| e.to_string();
            let scr = &x.conn.setup().roots[x.screen];
            let win = x.conn.generate_id().map_err(|er| e(&er))?;
            let aux = CreateWindowAux::new().background_pixel(scr.black_pixel).event_mask(EventMask::STRUCTURE_NOTIFY);
            x.conn.create_window(x11rb::COPY_DEPTH_FROM_PARENT, win, scr.root, 0, 0, w.max(1) as u16, h.max(1) as u16, 0, WindowClass::INPUT_OUTPUT, 0, &aux).map_err(|er| e(&er))?;
            x.conn.change_property8(PropMode::REPLACE, win, AtomEnum::WM_NAME, AtomEnum::STRING, title.as_bytes()).map_err(|er| e(&er))?;
            x.conn.change_property8(PropMode::REPLACE, win, x.net_wm_name, x.utf8, title.as_bytes()).map_err(|er| e(&er))?;
            x.conn.change_property32(PropMode::REPLACE, win, x.wm_protocols, AtomEnum::ATOM, &[x.wm_delete]).map_err(|er| e(&er))?;
            set_hints(x, win, w, h, resizable)?;
            x.conn.map_window(win).map_err(|er| e(&er))?;
            x.conn.flush().map_err(|er| e(&er))?;
            Ok(win as u64)
        })
    }
    fn set_hints(x: &X, win: u32, w: u32, h: u32, resizable: bool) -> Result<(), String> {
        // WM_NORMAL_HINTS: flags PMinSize|PMaxSize (16|32) when not resizable
        let mut hints = [0u32; 18];
        if !resizable { hints[0] = 16 | 32; hints[5] = w; hints[6] = h; hints[7] = w; hints[8] = h; }
        x.conn.change_property32(PropMode::REPLACE, win, AtomEnum::WM_NORMAL_HINTS, AtomEnum::WM_SIZE_HINTS, &hints).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn resize(win: u64, w: u32, h: u32, resizable: bool) {
        let _ = with_x(|x| {
            let _ = set_hints(x, win as u32, w, h, resizable);
            let _ = x.conn.configure_window(win as u32, &ConfigureWindowAux::new().width(w).height(h));
            let _ = x.conn.flush();
            Ok(())
        });
    }
    pub fn raise(win: u64) { let _ = with_x(|x| { let _ = x.conn.configure_window(win as u32, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE)); let _ = x.conn.flush(); Ok(()) }); }
    pub fn destroy(win: u64) { let _ = with_x(|x| { let _ = x.conn.destroy_window(win as u32); let _ = x.conn.flush(); Ok(()) }); }
    pub fn fd() -> Option<i32> {
        use std::os::fd::AsRawFd;
        XC.with(|c| c.borrow().as_ref().map(|x| x.conn.stream().as_raw_fd()))
    }
    pub fn poll_events() -> Vec<WinEvent> {
        XC.with(|c| {
            let c = c.borrow();
            let Some(x) = c.as_ref() else { return vec![] };
            let mut out = vec![];
            while let Ok(Some(ev)) = x.conn.poll_for_event() {
                match ev {
                    Event::ClientMessage(m) if m.type_ == x.wm_protocols && m.data.as_data32()[0] == x.wm_delete => out.push(WinEvent::Close(m.window as u64)),
                    Event::ConfigureNotify(c) => out.push(WinEvent::Resized(c.window as u64, c.width as u32, c.height as u32)),
                    _ => {}
                }
            }
            out
        })
    }
    pub fn flush() { XC.with(|c| { if let Some(x) = c.borrow().as_ref() { let _ = x.conn.flush(); } }); }
}

#[cfg(windows)]
mod imp {
    use super::WinEvent;
    use std::cell::RefCell;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    thread_local! { static EVENTS: RefCell<Vec<WinEvent>> = const { RefCell::new(Vec::new()) }; static REG: RefCell<bool> = const { RefCell::new(false) }; }
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
    unsafe extern "system" fn wndproc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_CLOSE => { EVENTS.with(|e| e.borrow_mut().push(WinEvent::Close(h as u64))); 0 }
            WM_SIZE => { let w = (lp & 0xffff) as u32; let hh = ((lp >> 16) & 0xffff) as u32; EVENTS.with(|e| e.borrow_mut().push(WinEvent::Resized(h as u64, w, hh))); 0 }
            _ => DefWindowProcW(h, msg, wp, lp),
        }
    }
    const CLASS: &str = "AuduioPluginWindow";
    fn style(resizable: bool) -> u32 { if resizable { WS_OVERLAPPEDWINDOW } else { WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX } }
    pub fn available() -> bool { true }
    pub fn create(title: &str, w: u32, h: u32, resizable: bool) -> Result<u64, String> {
        unsafe {
            let inst = GetModuleHandleW(std::ptr::null());
            let cls = wide(CLASS);
            REG.with(|r| {
                if !*r.borrow() {
                    let wc = WNDCLASSW { style: 0, lpfnWndProc: Some(wndproc), cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: std::ptr::null_mut(), hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW), hbrBackground: std::ptr::null_mut(), lpszMenuName: std::ptr::null(), lpszClassName: cls.as_ptr() };
                    RegisterClassW(&wc);
                    *r.borrow_mut() = true;
                }
            });
            let st = style(resizable);
            let mut rc = RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
            AdjustWindowRectEx(&mut rc, st, 0, 0);
            let t = wide(title);
            let hwnd = CreateWindowExW(0, cls.as_ptr(), t.as_ptr(), st, CW_USEDEFAULT, CW_USEDEFAULT, rc.right - rc.left, rc.bottom - rc.top, std::ptr::null_mut(), std::ptr::null_mut(), inst, std::ptr::null());
            if hwnd.is_null() { return Err("could not create the plugin window".into()); }
            ShowWindow(hwnd, SW_SHOW);
            Ok(hwnd as u64)
        }
    }
    pub fn resize(win: u64, w: u32, h: u32, resizable: bool) {
        unsafe {
            let mut rc = RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
            AdjustWindowRectEx(&mut rc, style(resizable), 0, 0);
            SetWindowPos(win as HWND, std::ptr::null_mut(), 0, 0, rc.right - rc.left, rc.bottom - rc.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }
    pub fn raise(win: u64) { unsafe { SetForegroundWindow(win as HWND); } }
    pub fn destroy(win: u64) { unsafe { DestroyWindow(win as HWND); } }
    pub fn fd() -> Option<i32> { None }
    pub fn pump() {
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 { TranslateMessage(&msg); DispatchMessageW(&msg); }
        }
    }
    pub fn poll_events() -> Vec<WinEvent> { pump(); EVENTS.with(|e| std::mem::take(&mut *e.borrow_mut())) }
    pub fn flush() {}
}

#[cfg(target_os = "macos")]
mod imp {
    //! AppKit host windows through the Objective-C runtime (no extra crates). The handle given to plugins is the
    //! window's content NSView (VST3 kPlatformTypeNSView / CLAP "cocoa" both want an NSView*). Everything runs on
    //! the engine's main thread, which is the process main thread, as AppKit requires.
    use super::WinEvent;
    use std::cell::{Cell, RefCell};
    use std::ffi::{c_void, CString};

    type Id = *mut c_void;
    type Sel = *const c_void;
    #[repr(C)] #[derive(Clone, Copy)] struct NSRect { x: f64, y: f64, w: f64, h: f64 }
    #[repr(C)] #[derive(Clone, Copy)] struct NSSize { w: f64, h: f64 }

    #[link(name = "AppKit", kind = "framework")] extern "C" {}
    #[link(name = "Foundation", kind = "framework")] extern "C" { static NSDefaultRunLoopMode: Id; }
    #[link(name = "objc")] extern "C" {
        fn objc_getClass(name: *const std::os::raw::c_char) -> Id;
        fn sel_registerName(name: *const std::os::raw::c_char) -> Sel;
        fn objc_msgSend();
        #[cfg(target_arch = "x86_64")] fn objc_msgSend_stret();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(p: *mut c_void);
    }

    fn cls(n: &str) -> Id { let c = CString::new(n).unwrap(); unsafe { objc_getClass(c.as_ptr()) } }
    fn sel(n: &str) -> Sel { let c = CString::new(n).unwrap(); unsafe { sel_registerName(c.as_ptr()) } }
    // typed views of objc_msgSend (it is a trampoline: the caller's signature is what counts)
    macro_rules! msg { ($ty:ty) => { unsafe { std::mem::transmute::<*const (), $ty>(objc_msgSend as *const ()) } } }
    fn send(o: Id, s: &str) -> Id { let f = msg!(extern "C" fn(Id, Sel) -> Id); f(o, sel(s)) }
    fn send_id(o: Id, s: &str, a: Id) -> Id { let f = msg!(extern "C" fn(Id, Sel, Id) -> Id); f(o, sel(s), a) }
    fn send_bool(o: Id, s: &str, b: bool) { let f = msg!(extern "C" fn(Id, Sel, i8)); f(o, sel(s), b as i8) }
    fn send_int(o: Id, s: &str, v: i64) -> i8 { let f = msg!(extern "C" fn(Id, Sel, i64) -> i8); f(o, sel(s), v) }
    fn send_u64(o: Id, s: &str, v: u64) { let f = msg!(extern "C" fn(Id, Sel, u64)); f(o, sel(s), v) }
    fn get_bool(o: Id, s: &str) -> bool { let f = msg!(extern "C" fn(Id, Sel) -> i8); f(o, sel(s)) != 0 }
    fn get_rect(o: Id, s: &str) -> NSRect {
        #[cfg(target_arch = "x86_64")] let f = unsafe { std::mem::transmute::<*const (), extern "C" fn(Id, Sel) -> NSRect>(objc_msgSend_stret as *const ()) };
        #[cfg(not(target_arch = "x86_64"))] let f = msg!(extern "C" fn(Id, Sel) -> NSRect);
        f(o, sel(s))
    }
    fn nsstring(s: &str) -> Id {
        let f = msg!(extern "C" fn(Id, Sel, *const u8, u64, u64) -> Id);
        f(send(cls("NSString"), "alloc"), sel("initWithBytes:length:encoding:"), s.as_ptr(), s.len() as u64, 4 /* NSUTF8StringEncoding */)
    }

    struct Win { window: Id, view: Id, w: u32, h: u32, closed: bool }
    thread_local! {
        static APP: Cell<Id> = Cell::new(std::ptr::null_mut());
        static WINS: RefCell<Vec<Win>> = RefCell::new(vec![]);
    }
    const TITLED: u64 = 1; const CLOSABLE: u64 = 2; const MINIATURIZABLE: u64 = 4; const RESIZABLE: u64 = 8;
    fn style(resizable: bool) -> u64 { TITLED | CLOSABLE | MINIATURIZABLE | if resizable { RESIZABLE } else { 0 } }

    fn app() -> Id {
        APP.with(|a| {
            if a.get().is_null() {
                let app = send(cls("NSApplication"), "sharedApplication");
                // Accessory: windows can come to the front, but no Dock icon or menu bar for the engine process
                send_int(app, "setActivationPolicy:", 1);
                send(app, "finishLaunching");
                a.set(app);
            }
            a.get()
        })
    }
    fn find<T>(view: u64, f: impl FnOnce(&mut Win) -> T) -> Option<T> {
        WINS.with(|w| w.borrow_mut().iter_mut().find(|x| x.view as u64 == view).map(f))
    }

    pub fn available() -> bool { true }
    pub fn create(title: &str, w: u32, h: u32, resizable: bool) -> Result<u64, String> {
        let pool = unsafe { objc_autoreleasePoolPush() };
        let app = app();
        let rect = NSRect { x: 0.0, y: 0.0, w: w.max(1) as f64, h: h.max(1) as f64 };
        let init = msg!(extern "C" fn(Id, Sel, NSRect, u64, u64, i8) -> Id);
        let window = init(send(cls("NSWindow"), "alloc"), sel("initWithContentRect:styleMask:backing:defer:"), rect, style(resizable), 2 /* buffered */, 0);
        if window.is_null() { unsafe { objc_autoreleasePoolPop(pool) }; return Err("could not create the plugin window".into()); }
        send_bool(window, "setReleasedWhenClosed:", false);
        let t: String = title.chars().take(200).collect();
        let ns = nsstring(&t); send_id(window, "setTitle:", ns); send(ns, "release");
        send(window, "center");
        send_id(window, "makeKeyAndOrderFront:", std::ptr::null_mut());
        send_bool(app, "activateIgnoringOtherApps:", true);
        let view = send(window, "contentView");
        unsafe { objc_autoreleasePoolPop(pool) };
        if view.is_null() { send(window, "close"); send(window, "release"); return Err("the plugin window has no content view".into()); }
        WINS.with(|v| v.borrow_mut().push(Win { window, view, w, h, closed: false }));
        Ok(view as u64)
    }
    pub fn resize(win: u64, w: u32, h: u32, resizable: bool) {
        find(win, |x| {
            send_u64(x.window, "setStyleMask:", style(resizable));
            let f = msg!(extern "C" fn(Id, Sel, NSSize)); f(x.window, sel("setContentSize:"), NSSize { w: w.max(1) as f64, h: h.max(1) as f64 });
            x.w = w; x.h = h;
        });
    }
    pub fn raise(win: u64) {
        find(win, |x| { send_id(x.window, "makeKeyAndOrderFront:", std::ptr::null_mut()); });
        let a = APP.with(|a| a.get()); if !a.is_null() { send_bool(a, "activateIgnoringOtherApps:", true); }
    }
    pub fn destroy(win: u64) {
        let w = WINS.with(|v| { let mut v = v.borrow_mut(); v.iter().position(|x| x.view as u64 == win).map(|i| v.remove(i)) });
        if let Some(x) = w {
            let pool = unsafe { objc_autoreleasePoolPush() };
            send_id(x.window, "orderOut:", std::ptr::null_mut());
            send(x.window, "close");
            send(x.window, "release");
            unsafe { objc_autoreleasePoolPop(pool) };
        }
    }
    pub fn fd() -> Option<i32> { None }
    pub fn poll_events() -> Vec<WinEvent> {
        let app = APP.with(|a| a.get());
        if app.is_null() { return vec![]; } // no window was ever opened: leave AppKit alone
        let pool = unsafe { objc_autoreleasePoolPush() };
        let next = msg!(extern "C" fn(Id, Sel, u64, Id, Id, i8) -> Id);
        let past = send(cls("NSDate"), "distantPast");
        let mode = unsafe { NSDefaultRunLoopMode };
        for _ in 0..512 {
            let ev = next(app, sel("nextEventMatchingMask:untilDate:inMode:dequeue:"), u64::MAX, past, mode, 1);
            if ev.is_null() { break; }
            send_id(app, "sendEvent:", ev);
        }
        send(app, "updateWindows");
        let mut out = vec![];
        WINS.with(|v| for x in v.borrow_mut().iter_mut() {
            if x.closed { continue; }
            // the close button orders the window out (it is not released: setReleasedWhenClosed NO)
            if !get_bool(x.window, "isVisible") && !get_bool(x.window, "isMiniaturized") { x.closed = true; out.push(WinEvent::Close(x.view as u64)); continue; }
            let r = get_rect(x.view, "frame");
            let (w, h) = (r.w.round().max(1.0) as u32, r.h.round().max(1.0) as u32);
            if (w, h) != (x.w, x.h) { x.w = w; x.h = h; out.push(WinEvent::Resized(x.view as u64, w, h)); }
        });
        unsafe { objc_autoreleasePoolPop(pool) };
        out
    }
    pub fn flush() {}
}

pub use imp::*;
