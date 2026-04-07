#!/bin/bash
set -e

echo "═══════════════════════════════════════════"
echo "  Realms Engine — Setup"
echo "═══════════════════════════════════════════"
echo ""

# ── Check prerequisites ──
check_command() {
  if ! command -v "$1" &>/dev/null; then
    echo "❌ $1 is required but not installed."
    echo "   $2"
    exit 1
  fi
}

check_command node "Install Node.js 18+: https://nodejs.org/"
check_command npm "Install Node.js 18+: https://nodejs.org/"
check_command psql "Install PostgreSQL 16+: https://www.postgresql.org/download/"

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ required (found v$(node -v))"
  exit 1
fi

echo "✓ Node.js $(node -v)"
echo "✓ PostgreSQL $(psql --version | head -1)"
echo ""

# ── Database setup ──
echo "── Database Configuration ──"
read -p "Database name [realms_game]: " DB_NAME
DB_NAME=${DB_NAME:-realms_game}

read -p "Database user [realms]: " DB_USER
DB_USER=${DB_USER:-realms}

read -sp "Database password [realms-password]: " DB_PASS
DB_PASS=${DB_PASS:-realms-password}
echo ""

read -p "PostgreSQL host [127.0.0.1]: " DB_HOST
DB_HOST=${DB_HOST:-127.0.0.1}

read -p "PostgreSQL port [5432]: " DB_PORT
DB_PORT=${DB_PORT:-5432}

echo ""
echo "── Server Configuration ──"
read -p "Server port [8080]: " PORT
PORT=${PORT:-8080}

echo ""
echo "Setting up database..."

# Try to create the user and database
# This assumes the current OS user has PostgreSQL superuser access, or use sudo -u postgres
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
  read -p "Press Enter once the database is created, or Ctrl+C to abort..."
  PSQL_CMD=""
fi

if [ -n "$PSQL_CMD" ]; then
  # Create user if not exists
  $PSQL_CMD -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
    $PSQL_CMD -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
  echo "✓ Database user '$DB_USER' ready"

  # Create database if not exists
  $PSQL_CMD -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
    $PSQL_CMD -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  echo "✓ Database '$DB_NAME' ready"

  # Grant privileges
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
npm install --production
echo "✓ Dependencies installed"

# ── Test database connection ──
echo ""
echo "Testing database connection..."
PGPASSWORD=$DB_PASS psql -U $DB_USER -h $DB_HOST -p $DB_PORT -d $DB_NAME -c "SELECT 1" &>/dev/null
if [ $? -eq 0 ]; then
  echo "✓ Database connection successful"
else
  echo "❌ Cannot connect to database. Check your credentials in .env"
  exit 1
fi

# ── Start the server ──
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
