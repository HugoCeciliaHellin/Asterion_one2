Asterion One:
A Desk-Scale Satellite Mission: Resilient Flight Software, Intermittent Communications, Predictive Digital Twin and Operational Security

BSc (Hons) Software Engineering, Dissertation, COM6016M
York St John University, May 2026
Author: Hugo Cecilia Hellin (Student ID: 250172942)
Supervisor: Dr Alexandros Evangelidis

Abstract
Asterion One is a desk-scale simulator that asks a straightforward question: how much of what NASA actually does can you reproduce on a Raspberry Pi-class machine using only open-source tools. The answer, it turns out, is quite a lot. The system brings together a Python flight software stack, a Node.js ground segment backed by PostgreSQL, a React operator console, and a first-principles digital twin built in Python/NumPy, all running as a single coherent system on commodity hardware. The dissertation evaluates it through 374 automated tests and four fault-injection scenarios, and makes the case that the methodological gap between £100K–£10M industrial simulators and the fragmented open-source tools available to students doesn't have to be as wide as it currently is.

Research Aim and Sub-Questions
Primary Research Question:
Can a hybrid architecture achieve NASA-level operational rigour using accessible, desk-scale technologies?

| Sub-RQ | Concern        | Question                                                                                                          |
|--------|----------------|-------------------------------------------------------------------------------------------------------------------|
| 1      | Communications | Can a contact-aware messaging design prevent data loss during simulated orbital outages?  |
| 2      | Resilience     | Can the system recover to a secure SAFE state in seconds following a fatal fault?  |
| 3      | Prediction     | Can a first-order physical model predict failures with at least 15 minutes of lead time, and explain them in plain language? |

System Architecture

| Segment           | Technology Stack                              | Responsibility                                         |
|-------------------|-----------------------------------------------|--------------------------------------------------------|
| Flight Software   | Python 3.11, systemd, Ed25519                 | FDIR state machine, watchdog, telemetry                |
| Ground Segment    | Node.js 20, Express, PostgreSQL 15            | REST API, WebSocket gateway, audit log                 |
| Operator Console  | React 18, Vite, tweetnacl-js                  | Five dashboard views, browser-side signing             |
| Digital Twin      | Python 3.11, NumPy                            | First-order RC thermal model, predictive alerts        |
| Infrastructure    | Docker, OpenTelemetry, Grafana                | Containerisation, observability, CI                    |

Requirements and Verification

| ID                     | Requirement                                              | Verification Method                       | Outcome    |
|------------------------|----------------------------------------------------------|-------------------------------------------|------------|
| REQ-FSW-STATE-01       | Explicit state machine (BOOT/NOMINAL/SAFE/CRITICAL)      | Fault injection campaign                  | PASS       |
| REQ-FSW-WD-03s         | Watchdog recovery under 3 seconds                        | kill-process injection (15.58 ms)         | PASS       |
| REQ-FSW-LOG-SECURE     | Hash-chained tamper-evident audit log                    | Chain verification endpoint               | PASS       |
| REQ-COM-ZERO-LOSS      | Zero command loss during outages                         | network-outage injection (0 lost)         | PASS       |
| REQ-COM-P95            | Command latency p95 under 2,000 ms                       | Statistical analysis (215.06 ms)          | PASS       |
| REQ-SEC-ED25519        | Ed25519 signed commands, reject invalid                  | bad-signature injection                   | PARTIAL¹   |
| REQ-GND-PLAN           | Visual contact window scheduling                         | Operator Console review                   | PASS       |
| REQ-OPS-OBSERVABILITY  | OpenTelemetry + Grafana stack                            | Dashboard inspection                      | PASS       |
| REQ-DT-EARLY-15m       | Predict violations at least 15 min ahead                 | Twin gate test                            | PASS       |
| REQ-DT-RATIONALE       | Human-readable alert rationale                           | Twin gate test                            | PASS       |

Getting Started
Everything you need to install, run, and reproduce the experiments is in USAGE_GUIDE.md.
The short version: you'll need Python 3.11+, Node.js 20+, and Docker Desktop. The system runs across four terminals, Ground API, React UI, Flight Software, and Digital Twin. All 374 tests and every fault-injection scenario from the dissertation can be run from scratch using the commands in that guide.

Evidence
The experiments supporting Chapter of Results were run and produced 22 raw artefacts, JSON outputs, pytest logs, and database snapshots, stored in the evidence/ directory. Each one maps to a specific table in the dissertation, and every scenario can be re-run independently by following the steps in USAGE_GUIDE.md.
