{ pkgs, lib, ... }:

# A developer preview of TruthMesh without Docker: the same four services the compose
# file runs — postgres, migrate, api, worker and web — as native processes.
#
#     devenv up          starts postgres, applies migrations, then api, worker and web
#     devenv shell       the toolchain only, no processes
#
# Open http://localhost:5173. The Vite dev server proxies the API, so the browser stays
# on one origin, exactly as nginx does in the container build.
#
# Ports match .env.example and docker-compose.yml so a .env written for one works for the
# other: postgres on 55432, the API on 3000, the interface on 5173.

let
	# Kept in one place because five things below have to agree on them: the postgres
	# service, DATABASE_URL, drizzle-kit, the API and the Vite proxy target.
	pgPort = 55432;
	pgUser = "superjoin";
	pgDatabase = "superjoin";
	apiPort = 3000;
	webPort = 5173;

	# Unix-socket-free, because the containers connect over TCP and the migrations,
	# tests and evaluation runner all read this same URL from the environment.
	databaseUrl = "postgres://${pgUser}:${pgUser}@localhost:${toString pgPort}/${pgDatabase}";

	# The API and the worker must see the same storage root: they exchange original PDFs
	# and derived parsing artifacts through it, which is why the compose file mounts one
	# volume at one path in both. Each process runs from its own directory, so a relative
	# STORAGE_DIR — and ./storage is what .env.example ships — would otherwise resolve to
	# apps/api/storage in one and apps/worker/storage in the other, and neither would find
	# what the other wrote. Anchor a relative value to the repository root instead.
	resolveStorageDir = ''
		STORAGE_DIR="''${STORAGE_DIR:-$DEVENV_ROOT/storage}"
		case "$STORAGE_DIR" in
			/*) ;;
			*) STORAGE_DIR="$DEVENV_ROOT/''${STORAGE_DIR#./}" ;;
		esac
		export STORAGE_DIR
		mkdir -p "$STORAGE_DIR"
	'';
in
{
	# ---------------------------------------------------------------------------------
	# Toolchain
	# ---------------------------------------------------------------------------------

	# Node 24, matching engines.node in package.json and the Dockerfile base image.
	languages.javascript = {
		enable = true;
		package = pkgs.nodejs_24;
		# The workspace is npm-based: package-lock.json is committed and the image builds
		# with `npm ci`, so installs here go through npm too rather than a second lockfile.
		npm = {
			enable = true;
			install.enable = true;
		};
	};

	packages = [
		pkgs.git
		# drizzle-kit and the evaluation runner are invoked through tsx.
		pkgs.postgresql_17 # psql and pg_isready on PATH for the wait loop and manual queries
	];

	# ---------------------------------------------------------------------------------
	# Configuration
	#
	# .env wins where it sets a value; the fallbacks below are the defaults from
	# .env.example so a fresh clone runs before anyone writes one. Without a model key
	# the pipeline runs in saved-output mode, which is a working preview.
	# ---------------------------------------------------------------------------------

	dotenv = {
		enable = true;
		filename = ".env";
	};

	env = {
		# Deliberately no PG* variables here. PGHOST, PGPORT and PGDATA are set by the
		# postgres module, and PGUSER must stay unset: devenv bootstraps the cluster with
		# psql as the initdb superuser, which is the OS user, so pointing PGUSER at the
		# application role makes that first connection fail before the role exists.
		# Everything in the workspace reads DATABASE_URL anyway.

		# Fallbacks, so a fresh clone runs before anyone writes a .env. mkDefault means a
		# value in .env wins; without one the processes would otherwise start with no
		# DATABASE_URL at all, since they do not go through enterShell.
		DATABASE_URL = lib.mkDefault databaseUrl;
		PORT = lib.mkDefault (toString apiPort);

		# The web dev server proxies to the API process, not to a container.
		VITE_API_TARGET = "http://localhost:${toString apiPort}";

		# @napi-rs/canvas and @huggingface/transformers ship prebuilt binaries that
		# expect the C++ runtime on the library path. On NixOS they additionally need
		# nix-ld enabled system-wide, since they look for a standard ELF loader.
		LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
	};

	enterShell = ''
		${resolveStorageDir}

		echo "TruthMesh dev environment"
		echo "  devenv up         postgres, migrations, api, worker, web"
		echo "  migrate           apply pending migrations by hand"
		echo "  db                psql against the dev database"
		echo "  npm test          444 tests; needs postgres up"
	'';

	# ---------------------------------------------------------------------------------
	# Postgres
	#
	# pgvector is required for candidate retrieval, so it comes from the extension list
	# rather than from a hand-run CREATE EXTENSION. pg-boss creates and owns its own
	# schema in this same database, so there is no separate queue service.
	# ---------------------------------------------------------------------------------

	services.postgres = {
		enable = true;
		package = pkgs.postgresql_17;
		extensions = extensions: [ extensions.pgvector ];
		# 55432 rather than 5432, for the reason docker-compose.yml gives: on 5432 a
		# stray local Postgres would answer, and migrations would land in someone
		# else's schema instead of failing loudly.
		port = pgPort;
		listen_addresses = "127.0.0.1";
		# Creates the login role and the database it owns, with the same name and
		# password the compose file uses, so one DATABASE_URL works against either.
		initialDatabases = [
			{
				name = pgDatabase;
				user = pgUser;
				pass = pgUser;
			}
		];
		# Runs after the database exists. The role needs superuser because the first
		# migration issues CREATE EXTENSION vector, which is not a trusted extension;
		# the compose file's POSTGRES_USER is a superuser for the same reason.
		initialScript = "ALTER ROLE ${pgUser} SUPERUSER;";
	};

	# ---------------------------------------------------------------------------------
	# Helper scripts
	# ---------------------------------------------------------------------------------

	scripts.migrate.exec = ''
		cd "$DEVENV_ROOT/packages/db" && npx drizzle-kit migrate
	'';

	scripts.db.exec = ''
		psql "$DATABASE_URL" "$@"
	'';

	# Drops the whole dev database directory. The preview is disposable; uploaded PDFs
	# under STORAGE_DIR are left alone because they are inputs, not derived state.
	scripts.db-reset.exec = ''
		echo "Removing $DEVENV_STATE/postgres — stop 'devenv up' first."
		rm -rf "$DEVENV_STATE/postgres"
	'';

	# ---------------------------------------------------------------------------------
	# Migrations
	#
	# A task rather than a process: it runs once, must succeed, and nothing that touches
	# the schema may start before it does — the same ordering the compose file gets from
	# `service_completed_successfully`.
	# ---------------------------------------------------------------------------------

	tasks."truthmesh:migrate" = {
		exec = ''cd "$DEVENV_ROOT/packages/db" && npx drizzle-kit migrate'';
		# Bare process names mean @ready here, so this waits for postgres to accept
		# connections rather than merely to have been spawned.
		after = [ "devenv:processes:postgres" ];
	};

	# ---------------------------------------------------------------------------------
	# Processes
	#
	# Ordering mirrors the compose file: postgres, then migrations, then the two Node
	# services, then the interface once the API answers.
	# ---------------------------------------------------------------------------------

	processes.api = {
		# --conditions development resolves the workspace packages to their TypeScript
		# source, so an edit in packages/ is picked up without a build step.
		exec = ''
			${resolveStorageDir}
			exec npx tsx watch --conditions development src/index.ts
		'';
		cwd = "apps/api";
		after = [ "truthmesh:migrate" ];
		ready = {
			http.get = {
				port = apiPort;
				path = "/ready";
			};
			initial_delay = 3;
			period = 3;
			probe_timeout = 5;
			failure_threshold = 20;
		};
	};

	processes.worker = {
		# The only process given model access, matching the compose file's service
		# boundaries: the API never holds the key.
		exec = ''
			${resolveStorageDir}
			exec npx tsx watch --conditions development src/index.ts
		'';
		cwd = "apps/worker";
		after = [ "truthmesh:migrate" ];
	};

	processes.web = {
		exec = ''exec npx vite --port ${toString webPort} --strictPort'';
		cwd = "apps/web";
		# Waits for the API to be ready, so the first page load is not a proxy error.
		after = [ "devenv:processes:api" ];
		ready = {
			http.get = {
				port = webPort;
				path = "/";
			};
			initial_delay = 2;
			period = 2;
			failure_threshold = 20;
		};
	};
}
