#!/bin/bash
set -e

echo "═══════════════════════════════════════════"
echo "  Realms Engine — Full Install (Ubuntu)"
echo "═══════════════════════════════════════════"
echo ""

# ── Install Node.js 20 LTS ──
if ! command -v node &>/dev/null; then
  echo "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "✓ Node.js installed: $(node -v)"
else
  echo "✓ Node.js already installed: $(node -v)"
fi

# ── Install PostgreSQL ──
if ! command -v psql &>/dev/null; then
  echo "Installing PostgreSQL..."
  sudo apt-get update -qq
  sudo apt-get install -y postgresql postgresql-contrib
  sudo systemctl enable postgresql
  sudo systemctl start postgresql
  echo "✓ PostgreSQL installed"
else
  echo "✓ PostgreSQL already installed"
  # Make sure it's running
  if ! sudo systemctl is-active --quiet postgresql; then
    sudo systemctl start postgresql
    echo "  Started PostgreSQL service"
  fi
fi

echo ""

# ── Run setup ──
chmod +x setup.sh
./setup.sh
