use std::path::{Path, PathBuf};
use syn::visit::{self, Visit};

const DISK_ADAPTERS: [(&str, &str); 3] = [
  ("log_file.rs", "append"),
  ("event_log/salt.rs", "write_private_file"),
  ("diagnostics_bundle.rs", "write_private_file"),
];
const OUTPUT_MACROS: [&str; 5] = ["println", "eprintln", "print", "eprint", "dbg"];
const FILE_WRITERS: [&str; 3] = ["OpenOptions", "write", "copy"];

struct SourcePolicy<'a> {
  file: &'a str,
  function: String,
  violations: Vec<String>,
}

impl SourcePolicy<'_> {
  fn is_disk_adapter(&self) -> bool {
    DISK_ADAPTERS.contains(&(self.file, self.function.as_str()))
  }

  fn reject(&mut self, name: &str) {
    self.violations.push(format!("{}::{}: {name}", self.file, self.function));
  }

  fn scan_macro_tokens(&mut self, tokens: proc_macro2::TokenStream) {
    use proc_macro2::TokenTree;
    let mut tokens = tokens.into_iter().peekable();
    while let Some(token) = tokens.next() {
      match token {
        TokenTree::Group(group) => self.scan_macro_tokens(group.stream()),
        TokenTree::Ident(identifier) => {
          let mut path = identifier.to_string();
          while {
            let mut lookahead = tokens.clone();
            let first_colon = matches!(lookahead.next(), Some(TokenTree::Punct(mark)) if mark.as_char() == ':');
            let second_colon = matches!(lookahead.next(), Some(TokenTree::Punct(mark)) if mark.as_char() == ':');
            first_colon && second_colon
          } {
            tokens.next();
            tokens.next();
            let Some(TokenTree::Ident(segment)) = tokens.next() else { break };
            path.push_str("::");
            path.push_str(&segment.to_string());
          }
          let invokes_macro = matches!(tokens.peek(), Some(TokenTree::Punct(mark)) if mark.as_char() == '!');
          if invokes_macro && OUTPUT_MACROS.contains(&path.as_str()) {
            self.reject(&path);
          }
          if let Ok(path) = syn::parse_str::<syn::Path>(&path) { self.visit_path(&path); }
        }
        _ => {}
      }
    }
  }
}

fn is_test_module(module: &syn::ItemMod) -> bool {
  module.attrs.iter().any(|attribute| attribute.path().is_ident("cfg") && attribute.parse_args::<syn::Path>().is_ok_and(|path| path.is_ident("test")))
}

impl<'ast> Visit<'ast> for SourcePolicy<'_> {
  fn visit_item_mod(&mut self, module: &'ast syn::ItemMod) {
    if !is_test_module(module) {
      visit::visit_item_mod(self, module);
    }
  }

  fn visit_item_fn(&mut self, function: &'ast syn::ItemFn) {
    let enclosing = std::mem::replace(&mut self.function, function.sig.ident.to_string());
    visit::visit_item_fn(self, function);
    self.function = enclosing;
  }

  fn visit_impl_item_fn(&mut self, function: &'ast syn::ImplItemFn) {
    if self.file == "log_file.rs" && function.sig.ident == "record" {
      self.reject("record(&str)");
    }
    let enclosing = std::mem::replace(&mut self.function, function.sig.ident.to_string());
    visit::visit_impl_item_fn(self, function);
    self.function = enclosing;
  }

  fn visit_macro(&mut self, invocation: &'ast syn::Macro) {
    let name = invocation.path.segments.last().unwrap().ident.to_string();
    if OUTPUT_MACROS.contains(&name.as_str()) {
      self.reject(&name);
    }

    self.scan_macro_tokens(invocation.tokens.clone());
    visit::visit_macro(self, invocation);
  }

  fn visit_path(&mut self, path: &'ast syn::Path) {
    let names: Vec<String> = path.segments.iter().map(|segment| segment.ident.to_string()).collect();
    let imports_console_output = names.len() > 1 && OUTPUT_MACROS.contains(&names.last().unwrap().as_str());
    if imports_console_output {
      self.reject(&names.join("::"));
    }
    let is_foreign_logging = names.len() > 1 && names.iter().any(|name| name == "log" || name == "tauri_plugin_log");
    if is_foreign_logging && self.file != "event_log/foreign.rs" {
      self.reject(&names.join("::"));
    }
    let exposes_raw_writer = names.iter().any(|name| name == "DiskFs" || name == "LogFs");
    if exposes_raw_writer && self.file != "log_file.rs" { self.reject(&names.join("::")); }
    let has_file_writer = names.iter().any(|name| name == "OpenOptions") || names.windows(2).any(|pair| pair[0] == "File" && pair[1] != "open");
    let calls_filesystem_writer = names.iter().any(|name| name == "fs") && names.iter().any(|name| FILE_WRITERS.contains(&name.as_str()));
    let imports_filesystem_namespace = names.len() > 1 && names.last().is_some_and(|name| name == "fs" || name == "glob") && names.iter().any(|name| name == "fs");
    if (has_file_writer || calls_filesystem_writer || imports_filesystem_namespace) && !self.is_disk_adapter() {
      self.reject(&names.join("::"));
    }
    visit::visit_path(self, path);
  }

  fn visit_item_use(&mut self, import: &'ast syn::ItemUse) {
    fn imported_paths(tree: &syn::UseTree, prefix: String) -> Vec<String> {
      match tree {
        syn::UseTree::Path(path) => imported_paths(&path.tree, format!("{prefix}{}::", path.ident)),
        syn::UseTree::Name(name) => vec![format!("{prefix}{}", name.ident)],
        syn::UseTree::Rename(rename) => vec![format!("{prefix}{}", rename.ident)],
        syn::UseTree::Glob(_) => vec![format!("{prefix}*")],
        syn::UseTree::Group(group) => group.items.iter().flat_map(|tree| imported_paths(tree, prefix.clone())).collect(),
      }
    }
    for name in imported_paths(&import.tree, String::new()) {
      let path = syn::parse_str::<syn::Path>(&name.replace('*', "glob")).unwrap();
      self.visit_path(&path);
    }
  }

  fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
    let method = call.method.to_string();
    let writes_bytes = ["write", "write_all", "write_fmt", "write_vectored"].contains(&method.as_str());
    let is_health_request = self.file == "daemon.rs" && self.function == "health_response";
    if writes_bytes && !self.is_disk_adapter() && !is_health_request {
      self.reject(&method);
    }
    visit::visit_expr_method_call(self, call);
  }
}

fn violations_in(file: &str, source: &str) -> Vec<String> {
  let syntax = syn::parse_file(source).expect("valid Rust source");
  let mut policy = SourcePolicy { file, function: String::new(), violations: Vec::new() };
  policy.visit_file(&syntax);
  policy.violations
}

fn rust_sources(folder: &Path) -> Vec<PathBuf> {
  let mut sources = Vec::new();
  for entry in std::fs::read_dir(folder).unwrap() {
    let path = entry.unwrap().path();
    if path.is_dir() {
      sources.extend(rust_sources(&path));
    } else if path.extension().is_some_and(|extension| extension == "rs") {
      sources.push(path);
    }
  }
  sources
}

#[test]
fn desktop_sources_have_no_unreviewed_output_sink() {
  let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
  let mut violations = Vec::new();
  for path in rust_sources(&root) {
    let relative = path.strip_prefix(&root).unwrap().to_str().unwrap();
    if relative == "event_log/arch_test.rs" || relative == "event_log/hostile_corpus.rs" || relative == "linear_growth.rs" {
      continue;
    }
    violations.extend(violations_in(relative, &std::fs::read_to_string(&path).unwrap()));
  }
  assert!(violations.is_empty(), "unreviewed output sinks:\n{}", violations.join("\n"));
}

#[test]
fn detects_console_logging_and_file_writes_in_new_sources() {
  for source in [
    "fn run() { println!(\"secret\"); }",
    "fn run() { format!(\"{}\", { println!(\"secret\"); 0 }); }",
    "macro_rules! leak { () => { println!(\"secret\"); }; }",
    "fn run() { serde_json::json!({ \"value\": { println!(\"secret\"); 0 } }); }",
    "mod nested { fn run() { println!(\"secret\"); } }",
    "fn run() { std::eprintln!(\"secret\"); }",
    "fn run() { dbg!(\"secret\"); }",
    "fn run() { log::warn!(\"secret\"); }",
    "use log::warn as leak; fn run() { leak!(\"secret\"); }",
    "use std::println as leak; fn run() { leak!(\"secret\"); }",
    "fn run() { std::fs::write(path, bytes); }",
    "fn run() { std::fs::File::create(path); }",
    "fn run() { std::fs::File::options(); }",
    "use std::fs as disk; fn run() { disk::write(path, bytes); }",
    "use std::fs::*; fn run() { write(path, bytes); }",
    "use std::fs::OpenOptions; fn run() { OpenOptions::new(); }",
    "fn run() { file.write_all(bytes); }",
    "fn run() { std::io::stdout().write(bytes); }",
    "use crate::log_file::{DiskFs, LogFs}; fn run() { DiskFs.append(path, bytes); }",
    "fn run() { tauri_plugin_log::Builder::new(); }",
  ] {
    assert!(!violations_in("new_module.rs", source).is_empty(), "missed {source}");
  }
}

#[test]
fn rejects_the_deprecated_string_logging_api() {
  let source = "impl DesktopLog { fn record(&self, text: &str) {} }";
  assert!(!violations_in("log_file.rs", source).is_empty());
}

#[test]
fn ignores_literals_comments_and_test_fixtures() {
  let source = "// println!(secret)\nfn run() { let text = \"log::warn!\"; } #[cfg(test)] mod tests { fn fixture() { std::fs::write(path, bytes); } }";
  assert!(violations_in("new_module.rs", source).is_empty());
}

#[test]
fn disk_exceptions_apply_only_to_the_reviewed_function() {
  for (file, function) in DISK_ADAPTERS {
    let reviewed = format!("fn {function}() {{ std::fs::OpenOptions::new(); }}");
    let unreviewed = "fn another_writer() { std::fs::OpenOptions::new(); }";
    assert!(violations_in(file, &reviewed).is_empty());
    assert!(!violations_in(file, unreviewed).is_empty());
  }
}

#[test]
fn clippy_configuration_bans_console_macros_and_file_creation() {
  let configuration = include_str!("../../clippy.toml");
  for path in [
    "log::trace", "log::debug", "log::info", "log::warn", "log::error", "log::log",
    "std::println", "std::eprintln", "std::print", "std::eprint", "std::dbg",
    "std::fs::File::create", "std::fs::OpenOptions::new",
  ] {
    assert!(configuration.contains(&format!("\"{path}\"")), "Clippy does not ban {path}");
  }
  for root in [include_str!("../lib.rs"), include_str!("../main.rs")] {
    assert!(root.contains("#![deny(clippy::disallowed_macros, clippy::disallowed_methods)]"));
  }
}

#[test]
fn excluded_fixtures_are_compiled_only_for_tests() {
  for (source, expected_modules) in [
    (include_str!("mod.rs"), &["arch_test", "hostile_corpus"][..]),
    (include_str!("../lib.rs"), &["linear_growth"][..]),
  ] {
    let file = syn::parse_file(source).unwrap();
    for expected in expected_modules {
      let module = file.items.iter().find_map(|item| match item {
        syn::Item::Mod(module) if module.ident == *expected => Some(module),
        _ => None,
      }).unwrap();
      assert!(is_test_module(module), "{expected} exposes test fixtures to production");
    }
  }
}
