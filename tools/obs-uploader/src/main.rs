//! obs-uploader: upload OBS recordings to their class automatically.
//!
//!   obs-uploader [run]                 watch OBS / the recording folder (default)
//!   obs-uploader upload <file>         upload one file now (resumes if interrupted)
//!   obs-uploader check                 test the token and the OBS connection
//!   obs-uploader install-task          start with Windows (Task Scheduler, at log on)
//!   obs-uploader uninstall-task
//!
//! Options: --config <path to config.toml> (default %APPDATA%\obs-uploader\config.toml),
//!          --session <class id> (upload/run: this class instead of the latest one).

use obs_uploader::api::Api;
use obs_uploader::config::{default_config_path, Config};
use obs_uploader::state::State;
use obs_uploader::{app, log};
use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::process::ExitCode;

const TASK_NAME: &str = "OBS recording uploader";

struct Args {
    command: String,
    file: Option<PathBuf>,
    config: PathBuf,
    session: Option<u64>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        command: "run".into(),
        file: None,
        config: default_config_path(),
        session: None,
    };
    let mut iter = std::env::args().skip(1);
    let mut positional = Vec::new();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--config" => args.config = PathBuf::from(iter.next().ok_or("--config needs a path")?),
            "--session" => {
                let value = iter.next().ok_or("--session needs a class id")?;
                args.session = Some(value.parse().map_err(|_| "--session must be a number")?);
            }
            "-h" | "--help" => return Err(String::new()),
            _ => positional.push(arg),
        }
    }
    if let Some(command) = positional.first() {
        args.command = command.clone();
    }
    if args.command == "upload" {
        args.file = Some(PathBuf::from(
            positional.get(1).ok_or("upload needs the recording file")?,
        ));
    }
    Ok(args)
}

fn usage() {
    eprintln!("usage: obs-uploader [run | upload <file> | check | install-task | uninstall-task] [--config <config.toml>] [--session <class id>]");
}

fn schtasks(arguments: &[&str]) -> ExitCode {
    match std::process::Command::new("schtasks")
        .args(arguments)
        .status()
    {
        Ok(status) if status.success() => ExitCode::SUCCESS,
        Ok(status) => {
            eprintln!("schtasks failed ({status})");
            ExitCode::FAILURE
        }
        Err(err) => {
            eprintln!("cannot run schtasks: {err}");
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            if !message.is_empty() {
                eprintln!("{message}");
            }
            usage();
            return ExitCode::from(2);
        }
    };
    match args.command.as_str() {
        "install-task" => {
            let exe = std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            let action = format!("\"{exe}\" run --config \"{}\"", args.config.display());
            return schtasks(&[
                "/Create", "/TN", TASK_NAME, "/TR", &action, "/SC", "ONLOGON", "/RL", "LIMITED",
                "/F",
            ]);
        }
        "uninstall-task" => return schtasks(&["/Delete", "/TN", TASK_NAME, "/F"]),
        _ => {}
    }
    let mut config = match Config::load(&args.config) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("{message}");
            eprintln!("Create it as described in tools/obs-uploader/README.md.");
            return ExitCode::FAILURE;
        }
    };
    if args.session.is_some() {
        config.session_id = args.session;
    }
    log::init(config.state_path().with_file_name("obs-uploader.log"));
    match args.command.as_str() {
        "run" => app::run(&config),
        "upload" => {
            let api = Api::new(&config.api_base, &config.token);
            let mut state = State::load(&config.state_path());
            let file = args.file.expect("checked in parse_args");
            if app::upload_one(&api, &file, &mut state, &config) {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        "check" => {
            let api = Api::new(&config.api_base, &config.token);
            let mut ok = true;
            match api.latest_target() {
                Ok(Some(target)) => log::line(&format!(
                    "token OK; latest class: \"{}\"",
                    target["title"].as_str().unwrap_or("?")
                )),
                Ok(None) => log::line("token OK; no recent class linked to a course yet"),
                Err(err) => {
                    ok = false;
                    log::line(&format!("token check failed: {err}"));
                }
            }
            if !config.recordings_dir.is_dir() {
                ok = false;
                log::line(&format!(
                    "recordings_dir {} does not exist",
                    config.recordings_dir.display()
                ));
            }
            let address = config
                .obs_websocket_url
                .trim_start_matches("ws://")
                .split('/')
                .next()
                .unwrap_or("")
                .to_string();
            let reachable = address
                .to_socket_addrs()
                .ok()
                .and_then(|mut found| found.next())
                .map(|addr| {
                    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2))
                        .is_ok()
                })
                .unwrap_or(false);
            if reachable {
                log::line("OBS WebSocket is reachable");
            } else {
                log::line("OBS WebSocket is not reachable (OBS closed or its WebSocket server off): the folder is watched instead");
            }
            if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        other => {
            eprintln!("unknown command {other}");
            usage();
            ExitCode::from(2)
        }
    }
}
