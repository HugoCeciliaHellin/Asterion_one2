Asterion One - Usage Guide
A desk-scale satellite operations simulator built to demonstrate NASA level operational rigour on commodity hardware. The system runs across three layers: Flight Segment (Python), Ground Segment (Node.js + React + PostgreSQL), and Digital Twin (Python/NumPy).

1. What you'll need

Python 3.11 or higher
Node.js 20 or higher with npm 10+
Docker Desktop (must be running)
Git

2. Installation
# Clone the repository
git clone https://github.com/HugoCeciliaHellin/Asterion_one2.git
cd Asterion_one2

# Set up a Python virtual environment
python -m venv .venv
source .venv/Scripts/activate     # Windows Git Bash
# source .venv/bin/activate         # Linux/macOS

# Install Python dependencies
pip install -r flight/requirements.txt
pip install -r twin/requirements.txt

# Install Node.js dependencies
cd ground && npm install && cd ..
cd ground/ui && npm install && cd ../..

3. Database Setup

# Spin up PostgreSQL on port 5433
docker compose up -d

# Make sure it's ready before continuing
docker exec asterion-postgres pg_isready -U asterion

# Run migrations
cd ground
POSTGRES_PORT=5433 npx knex migrate:latest --knexfile knexfile.js
NODE_ENV=test POSTGRES_PORT=5433 npx knex migrate:latest --knexfile knexfile.js
cd ..

4. Running the System
You'll need four terminals open. Run one command in each:
# Terminal 1 Ground API + WebSocket Gateway
cd ground
POSTGRES_PORT=5433 node src/index.js
# Terminal 2 Operator Console (React)
cd ground/ui
npm run dev
# Terminal 3 Flight Software
source .venv/Scripts/activate
ASTERION_GROUND_WS_URL=ws://localhost:8081/flight python -m flight
# Terminal 4 Digital Twin
source .venv/Scripts/activate
GROUND_API_BASE=http://localhost:3000/api python -m twin.twin_api

Where to find each service
Service              -      URL
Operator Console     -      http://localhost:5173
Ground API           -      http://localhost:3000/api
Flight WebSocket     -      ws://localhost:8081/flight

5. Reproducing the Dissertation Experiments
The fault-injection scenarios below reproduce the empirical results from Chapter of Results. Run them against the live system.

Sub-RQ1 - Communications Resilience (DTN)
python infra/fault_injector.py inject network-outage --duration 120

Reproduces the zero-loss store-and-forward results. The output JSON includes missing_count, gaps, queue_remaining, and p95_latency_ms.

Sub-RQ2 - Fault Detection, Isolation and Recovery (FDIR)

# Watchdog recovery target is under 3000 ms
python infra/fault_injector.py inject kill-process

# Thermal spike forcing T3 transition (NOMINAL → SAFE)
python infra/fault_injector.py inject thermal-spike --temp 85 --duration 60

# Cascade escalation to CRITICAL (T6)
python infra/fault_injector.py inject cascade-failure

# Ed25519 bad-signature rejection
python infra/fault_injector_bad_sig.py

These four scenarios produce the evidence in Tables of the literature review.
Sub-RQ3 - Digital Twin Predictive Fidelity

# Run the two formal gate tests
python -m pytest twin/tests/ -k "gate" -v

# Run a single Twin prediction cycle
python -m twin.twin_api --once

6. Running the Test Suite
374 tests in total, spread across all three tiers.

# Python tests (Flight + Twin)
python -m pytest flight/ twin/ -v

# Node.js tests (Ground Segment)
cd ground
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest --forceExit --detectOpenHandles
cd ..

# Browser-side cryptography tests
node ground/ui/src/lib/__tests__/canonical_json.test.mjs
cd ground/ui && node src/lib/__tests__/crypto.test.mjs && cd ../..

All 374 tests should pass.

Flight Segment State Machine
The Flight Software moves through four states via seven transitions:

Transition   -     Trigger
T1           -     Self-test passed
T2           -     Self-test failed
T3           -     Fault detected (temperature, voltage, SOC, or error rate)
T5           -     All faults cleared + 30 s stability timer
T6           -     Watchdog restarts exceed MAX_WD_RESTARTS (3)

Default fault thresholds: CPU temperature above 75 °C, voltage below 4.6 V, battery SOC below 10%, communications error rate above 10%.

7. Repository Layout
asterion-one/
├── flight/           Python Flight Software
├── ground/           Node.js Ground Segment + React UI
├── twin/             Python Digital Twin
├── infra/            Fault injection + observability
├── evidence/         Empirical evidence (dissertation Chapter of Results)
└── docker-compose.yml