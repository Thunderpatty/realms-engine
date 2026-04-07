#!/bin/bash
set -e

echo "═══════════════════════════════════════════"
echo "  Realms Engine — Setup"
echo "═══════════════════════════════════════════"
echo ""

# ── Detect non-interactive mode ──
NONINTERACTIVE=false
if [ ! -t 0 ]; then
  NONINTERACTIVE=true
fi

# ── Parse flags ──
USE_DEFAULTS=false
for arg in "$@"; do
  case "$arg" in
    --defaults) USE_DEFAULTS=true ;;
  esac
done

# ── Helper: prompt with default (skips in non-interactive/defaults mode) ──
prompt() {
  local var_name="$1" prompt_text="$2" default="$3" silent="$4"
  if [ "$USE_DEFAULTS" = true ] || [ "$NONINTERACTIVE" = true ]; then
    eval "$var_name=\"$default\""
    return
  fi
  if [ "$silent" = "silent" ]; then
    read -sp "$prompt_text" value
    echo ""
  else
    read -p "$prompt_text" value
  fi
  eval "$var_name=\"${value:-$default}\""
}

# ── Install Node.js if missing ──
if ! command -v node &>/dev/null; then
  echo "Node.js not found — installing Node.js 20 LTS..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "❌ Cannot auto-install Node.js on this system."
    echo "   Install Node.js 18+: https://nodejs.org/"
    exit 1
  fi
  echo "✓ Node.js installed: $(node -v)"
else
  echo "✓ Node.js $(node -v)"
fi

# ── Verify Node version ──
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ required (found $(node -v))"
  exit 1
fi

# ── Install PostgreSQL if missing ──
if ! command -v psql &>/dev/null; then
  echo "PostgreSQL not found — installing..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y postgresql postgresql-contrib
    sudo systemctl enable postgresql
    sudo systemctl start postgresql
  else
    echo "❌ Cannot auto-install PostgreSQL on this system."
    echo "   Install PostgreSQL 16+: https://www.postgresql.org/download/"
    exit 1
  fi
  echo "✓ PostgreSQL installed"
else
  echo "✓ PostgreSQL $(psql --version | head -1)"
  # Make sure it's running
  if command -v systemctl &>/dev/null; then
    if ! sudo systemctl is-active --quiet postgresql 2>/dev/null; then
      sudo systemctl start postgresql
      echo "  Started PostgreSQL service"
    fi
  fi
fi

echo ""

# ── Database configuration ──
echo "── Database Configuration ──"
prompt DB_NAME  "Database name [realms_game]: "      "realms_game"
prompt DB_USER  "Database user [realms]: "            "realms"
prompt DB_PASS  "Database password [realms-password]: " "realms-password" silent
prompt DB_HOST  "PostgreSQL host [127.0.0.1]: "       "127.0.0.1"
prompt DB_PORT  "PostgreSQL port [5432]: "             "5432"

echo ""
echo "── Server Configuration ──"
prompt PORT     "Server port [8080]: "                "8080"

echo ""
echo "Setting up database..."

# ── Create database user and database ──
if sudo -u postgres psql -c "SELECT 1" &>/dev/null; then
  PSQL_CMD="sudo -u postgres psql"
elif psql -U postgres -c "SELECT 1" &>/dev/null; then
  PSQL_CMD="psql -U postgres"
else
  echo ""
  echo "⚠ Cannot connect to PostgreSQL as superuser."
  echo "  Please create the database manually:"
  echo ""
  echo "  sudo -u postgres psql"
  echo "  CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
  echo "  CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  echo "  \\q"
  echo ""
  if [ "$NONINTERACTIVE" = true ] || [ "$USE_DEFAULTS" = true ]; then
    echo "❌ Cannot proceed non-interactively without PostgreSQL superuser access."
    exit 1
  fi
  read -p "Press Enter once the database is created, or Ctrl+C to abort..."
  PSQL_CMD=""
fi

if [ -n "$PSQL_CMD" ]; then
  $PSQL_CMD -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
    $PSQL_CMD -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
  echo "✓ Database user '$DB_USER' ready"

  $PSQL_CMD -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
    $PSQL_CMD -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  echo "✓ Database '$DB_NAME' ready"

  $PSQL_CMD -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" 2>/dev/null || true
fi

# ── Generate .env ──
SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cat > .env << EOF
PORT=$PORT
HOST=0.0.0.0
POSTGRES_HOST=$DB_HOST
POSTGRES_PORT=$DB_PORT
POSTGRES_USER=$DB_USER
POSTGRES_PASSWORD=$DB_PASS
POSTGRES_DB=$DB_NAME
SESSION_SECRET=$SESSION_SECRET
SESSION_NAME=realms_sid
RATE_LIMIT_AUTH=20
RATE_LIMIT_GAME=300
RATE_LIMIT_POLL=600
EOF

echo "✓ Configuration saved to .env"

# ── Install dependencies ──
echo ""
echo "Installing dependencies..."
npm install --omit=dev
echo "✓ Dependencies installed"

# ── Test database connection ──
echo ""
echo "Testing database connection..."
if PGPASSWORD="$DB_PASS" psql -U "$DB_USER" -h "$DB_HOST" -p "$DB_PORT" -d "$DB_NAME" -c "SELECT 1" &>/dev/null; then
  echo "✓ Database connection successful"
else
  echo "❌ Cannot connect to database. Check your credentials in .env"
  exit 1
fi

# ── Done ──
echo ""
echo "═══════════════════════════════════════════"
echo "  Setup complete!"
echo "═══════════════════════════════════════════"
echo ""
echo "  Start the server:"
echo "    node server.js"
echo ""
echo "  Or with pm2 (recommended for production):"
echo "    npm install -g pm2"
echo "    pm2 start server.js --name realms"
echo ""
echo "  Then open: http://localhost:$PORT"
echo ""
echo "  The database tables will be created automatically"
echo "  on first startup."
echo ""
echo "  To customize the game world, edit the files in"
echo "  content/ — see CONTENT-GUIDE.md for details."
echo ""
