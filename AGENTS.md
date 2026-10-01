AGENT.md: MISA AMIS Timesheet Evaluation Harness

This document defines the system specifications, domain rules, data contracts,
and architectural blueprint for migrating the client-side userscript logic into
a standalone, automated Evaluation & Testing Harness.

1. System Overview & Objectives

1.1 Purpose

The harness acts as an automated engine that ingests MISA AMIS attendance
network traffic, API payloads, or mock fixtures, evaluates an employee’s monthly
attendance against enterprise scheduling rules, and outputs structured
classification reports (missing punches, pending requests, approved leaves,
public holidays, and in-progress shifts).

1.2 Target System Context

  - Platform: MISA AMIS Enterprise Cloud (amisapp.misa.vn)
  - Subsystem: Employee Attendance & Timesheet Engine (EmployeeCnBAPI)
  - Primary Source of Truth: Timesheet detail grid and attendance request paging
    endpoints.

1.3 Key Architectural Goals

1.  Decouple Business Logic from DOM: Shift all classification, date parsing,
    and request cross-referencing logic away from the browser DOM and userscript
    context into an environment-agnostic core engine.
2.  Deterministic Timezone Handling: Enforce strict UTC+7 (Asia/Ho_Chi_Minh)
    processing to prevent date-boundary shifting bugs.
3.  Pluggable Ingestion: Allow data ingestion via multiple adapters: static
    HAR/JSON replay, headless browser interceptors, or direct authenticated API
    calls.
4.  Pluggable Reporting: Output structured JSON results to CLI stdout, webhook
    alerts (Slack, Teams, Telegram), or continuous regression test runners.

2. Ingestion & API Data Contracts

The harness consumes data from two primary endpoints.

2.1 Timesheet Detail Endpoint

  - Path: /APIS/g1/EmployeeCnBAPI/api/TimeSheet/get-timesheetdatadetail
  - Method: POST
  - Request Schema:
      - TimeSheetID (Integer): Identifier of the timesheet period.
      - FromDate (ISO 8601 String): Period start date (e.g.,
        YYYY-MM-01T00:00:00.000+07:00).
      - ToDate (ISO 8601 String): Period end date (e.g.,
        YYYY-MM-31T00:00:00.000+07:00).
  - Response Payload Structure:
      - Data.DataDetail (Array): Daily records for the requested period.
      - Data.Holiday (Array): Company and national holiday calendar entries
        covering the period.
      - Data.ConfigDetail (Array): Field layout configuration metadata.
      - Data.AdvanceWorkingAndCompensate (Object): Period-level compensatory
        hour metrics.

Internal Record Attributes (DataDetail[i]):

  - TimeSheetDate (ISO 8601 String): Date of the attendance day.
  - EmployeeID (Integer), FullName (String), EmployeeCode (String).
  - TimeSheetData (JSON-encoded String): Array containing shift execution
    objects.

Shift Object Attributes (inside TimeSheetData):

  - DayType (Integer): Day classification (1 = Weekday, 2 = Weekend, 3 = Public
    Holiday).
  - StartTime / EndTime (String): Standard shift window (HH:mm:ss).
  - CheckStartTime / CheckEndTime (ISO 8601 String or null): Actual timestamps
    of biometric punches.
  - Working (Float): System-computed total work units credited.
  - TotalWorkingActual (Float): Physically worked shift units.
  - TotalLeave (Float): Total absent/leave units recorded on the shift.
  - TotalLeaveHoliday (Float): Holiday leave units credited.
  - WorkingHoliday (JSON-encoded String or null): Holiday name and credit
    mapping.
  - AttendanceTypeName (String or null): Specific leave category title.
  - ListAttendance (JSON-encoded String or null): Array of approved leave
    allocations.
  - DataInfo (JSON-encoded String): Contains operational metadata, biometric
    IDs, and linked Applications.

2.2 Attendance Applications Endpoint

  - Path: /APIS/g1/EmployeeCnBAPI/api/AttendanceEmployee/v2/datapaging
  - Method: POST
  - Request Schema:
      - Pagination options (PageIndex, PageSize), year/month filters, and
        employee IDs.
  - Response Payload Structure (Data Array):
      - AttendanceID (Integer): Unique application ID.
      - AttendanceTypeName (String): E.g., "Làm việc từ xa (WFH)", "Nghỉ phép",
        "Gặp khách hàng", "Đi công tác".
      - FromDate / ToDate (ISO 8601 String): Duration of the request.
      - LeaveDay (Float): Requested units of leave/remote work (e.g., 0.5, 1.0).
      - Status (Integer): Approval state.
          - 1 = Pending (Chờ duyệt)
          - 2 = Approved (Đã duyệt)
          - 3 = Rejected / Cancelled (Từ chối / Đã hủy)
      - Reason (String): Justification text submitted by the employee.

3. Domain Rules & Invariant Specifications

The harness must enforce the following business invariants during evaluation:

3.1 Timezone Invariant (UTC+7)

  - Rule: All raw timestamp strings terminating in +07:00 must be decomposed
    using local date parts (YYYY-MM-DD).
  - Prohibition: Converting to standard ISO UTC strings (.toISOString()) is
    strictly prohibited. UTC conversions subtract 7 hours, shifting midnight
    (00:00:00+07:00) back to 17:00:00 of the previous calendar day and
    invalidating all date-level classifications.

3.2 Temporal Boundary Rules

  - Future Dates: Any record where the date is strictly greater than the current
    local calendar day (date > today) must be ignored for missing punch
    analysis.
  - Current Day (today):
      - If a check-in is present but check-out has not occurred, classify as
        In-Progress / Pending Check-out, never as a missing punch.
      - If no punches and no requests exist, classify as Awaiting Punch /
        In-Progress.
  - Weekends: Saturdays and Sundays (dayOfWeek === 0 || dayOfWeek === 6) are
    exempt from attendance requirements unless an active, mandatory shift
    assignment is present.

3.3 Public Holiday Invariant

  - Condition: A day is considered a Public Holiday if:
      - DayType === 3, OR
      - TotalLeaveHoliday > 0, OR
      - The date matches any range inside Data.Holiday, OR
      - WorkingHoliday contains a valid parsed payload.
  - Resolution: Public holidays are complete by definition. They must never
    trigger missing punch alerts or incomplete shift deductions, regardless of
    punch presence.

3.4 Work Unit Invariant

  - A standard working shift requires 1.0 total credit unit.
  - Total credit is calculated as:
    \text{Total Credit} = \text{TotalWorkingActual} + \text{ApprovedLeaveUnits} + \text{HolidayCredit}
  - If \text{Total Credit} \ge 1.0, the day is satisfied.
  - If an approved leave accounts for 0.5 and actual work accounts for 0.5, the
    day is completely satisfied.

4. Classification State Machine

For each eligible calendar day (past or present weekday), execute the following
precedence hierarchy:

[Day Evaluation]
       │
       ▼
1. Is it Weekend (Sat/Sun)? ──────────► [YES] ──► SKIP
       │ [NO]
       ▼
2. Is Date in the Future? ────────────► [YES] ──► SKIP
       │ [NO]
       ▼
3. Is Public Holiday? ────────────────► [YES] ──► CLASSIFY: Public Holiday (Clean)
   (DayType 3 / Holiday Calendar)
       │ [NO]
       ▼
4. Has Pending Requests? ─────────────► [YES] ──► CLASSIFY: Pending Approval
   (Applications with Status = 1)                 (WFH / Leave pending manager action)
       │ [NO]
       ▼
5. Evaluate Credit (Work + Leave)
       │
       ├─► Total Credit >= 1.0 ───────► CLASSIFY: Satisfied / Approved Leave
       │
       └─► Total Credit < 1.0
             │
             ├─► Is Today? ───────────► CLASSIFY: Today / Partial In-Progress
             │
             └─► Past Day?
                   │
                   ├─► Missing In/Out Punches ──► CLASSIFY: Missing Punch Alert (CRITICAL)
                   │
                   └─► Under 1.0 Credit ────────► CLASSIFY: Incomplete Work Unit (WARNING)

5. Harness Architecture Design

5.1 Component Topology

┌────────────────────────────────────────────────────────────────────────┐
│                          INSPECTION HARNESS                            │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   ┌───────────────────────────┐      ┌─────────────────────────────┐   │
│   │     Ingestion Layer       │      │     Application Cache       │   │
│   │ - HAR Replay Adapter      │      │ - In-memory Map             │   │
│   │ - Live HTTP Client        │      │ - Key: AttendanceID         │   │
│   │ - Headless Session Proxy  │      │ - Type, Status, Units       │   │
│   └─────────────┬─────────────┘      └──────────────┬──────────────┘   │
│                 │                                   │                  │
│                 ▼                                   ▼                  │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                   Evaluation Engine Core                       │   │
│   │ - Date Normalizer (UTC+7 Enforcement)                          │   │
│   │ - Public Holiday Validator                                     │   │
│   │ - Application Cross-Referencer                                 │   │
│   │ - Credit Unit & Punch Auditor                                  │   │
│   └─────────────────────────────┬──────────────────────────────────┘   │
│                                 │                                      │
│                                 ▼                                      │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                   Reporting & Adapter Layer                    │   │
│   │ - Structured Audit Report (JSON)                               │   │
│   │ - Test Assertion Evaluator (Pass/Fail)                         │   │
│   │ - Webhook / Notification Exporter                              │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

5.2 Layer Responsibilities

1. Ingestion Layer

  - Ingests HTTP transactions without executing DOM rendering.
  - Handles session management, authentication tokens (x-sessionid,
    cf_clearance, Bearer JWTs), or parses pre-recorded .har archives.
  - Normalizes responses into memory.

2. Application Cache

  - Maps application records by AttendanceID.
  - Resolves display labels for pending applications where the timesheet grid
    response lacks populated category strings.

3. Evaluation Engine Core

  - Pure functional domain service.
  - Accepts (timesheetDetails, holidayCalendar, applicationMap,
    systemClockDate).
  - Returns an aggregated report containing categorized date lists.

4. Reporting Layer

  - Converts engine output into consumers:
      - CI/CD Regression Runner: Asserts that zero unexpected missingPunches
        exist for verified historical test runs.
      - Alert Webhook: Formats alerts for team members who forgot to check in or
        have pending approvals.

6. Output Schema Specification

The harness core must produce output conforming to the following data contract:

6.1 Report Summary Object

  - employee:
      - id (Integer), code (String), fullName (String), department (String)
  - period:
      - year (Integer), month (Integer), startDate (String), endDate (String)
  - metrics:
      - totalWorkingDays (Integer): Total weekdays elapsed up to evaluation
        time.
      - satisfiedDays (Integer): Days with \ge 1.0 valid credit.
      - pendingRequestsCount (Integer)
      - missingPunchesCount (Integer)
      - approvedLeavesCount (Integer)
      - publicHolidaysCount (Integer)
  - categories:
      - missingPunches: Array of { date, isToday, note, missingType: "CHECK_IN"
        | "CHECK_OUT" | "BOTH" }
      - pendingApproval: Array of { date, isToday, applicationId, typeName,
        requestedUnits, punchWindow }
      - approvedLeaveAndWfh: Array of { date, isToday, typeName, units }
      - publicHolidays: Array of { date, isToday, holidayName }
      - inProgressOrPartial: Array of { date, isToday, actualWorkUnits,
        leaveUnits, note }

7. Test Matrix & Edge Case Verification

The test harness must validate the engine using the following test fixtures:

| Case ID   | Scenario                       | Input Fixture Conditions                                                          | Expected Classification                                       |
| --------- | ------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **TC-01** | Standard Perfect Day           | Weekday, CheckIn: 08:00, CheckOut: 17:30, Working: 1.0                            | Satisfied (No alerts)                                         |
| **TC-02** | Unexcused Missing Punch        | Past weekday, CheckIn: null, CheckOut: null, Leave: 0                             | `missingPunches` (`BOTH`)                                     |
| **TC-03** | Missing Single Punch           | Past weekday, CheckIn: 08:00, CheckOut: null                                      | `missingPunches` (`CHECK_OUT`)                                |
| **TC-04** | Half-Day Work + Half-Day Leave | Past weekday, In: 09:30, Out: 17:30, ActualWork: 0.5, ApprovedLeave: 0.5          | Satisfied (`approvedLeaveAndWfh` = 0.5)                       |
| **TC-05** | National Holiday (Quốc khánh)  | Weekday (01/09), DayType: 3, In: null, Out: null, TotalLeaveHoliday: 1.0          | `publicHolidays` (Exempt from punches)                        |
| **TC-06** | Pending WFH Application        | Weekday, Applications: `[{ID: 48034, Status: 1}]`, CheckIn: null, CheckOut: 17:58 | `pendingApproval` (Not flagged as missing punch)              |
| **TC-07** | Current Day In-Progress        | Current calendar day, CheckIn: 08:05, CheckOut: null                              | `inProgressOrPartial` (Pending check-out)                     |
| **TC-08** | Date Rollover / Timezone Guard | Timestamps terminating in `00:00:00.000+07:00`                                    | Must match local date without rolling to previous day         |
| **TC-09** | Empty Timesheet Month          | Entire month populated with default `TotalLeave: 1.0` and no applications         | Future days skipped; past weekdays flagged as missing punches |

8. Migration Roadmap for AI & Engineering Agents

Follow this step-by-step procedure when implementing the harness:

1.  Phase 1: Environment & Fixture Setup

      - Create an isolated harness environment (e.g., Node.js / TypeScript,
        Python, or Go).
      - Store raw JSON dumps from previous sessions (timesheetdatadetail and
        datapaging) in a test/fixtures directory.

2.  Phase 2: Core Domain Logic Migration

      - Port the pure validation functions into a stateless domain module:
          - Date normalization and timezone guard.
          - Shift evaluation and credit calculator.
          - Precedence classification engine.
      - Verify all functions operate without DOM access (window, document,
        XMLHttpRequest).

3.  Phase 3: Fixture-Driven Unit Tests

      - Write test suites corresponding to test matrix cases TC-01 through
        TC-09.
      - Run the classification engine against static fixtures to assert that
        output matches expected JSON classifications.

4.  Phase 4: Ingestion Adapter Implementation

      - HAR Replay Adapter: Ingests browser network export archives (.har) to
        run offline regression audits.
      - HTTP Client Adapter: Connects directly to amisapp.misa.vn using supplied
        session cookies/tokens to fetch real-time timesheet state.

5.  Phase 5: Output & Notification Adapters

      - Construct CLI output tables for terminal workflows.
      - Implement webhook adapters for automated daily notifications.

