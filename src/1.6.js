// ==UserScript==
// @name         MISA AMIS Attendance, WFH & Leave Tracker
// @namespace    https://amisapp.misa.vn/
// @version      1.6
// @description  Highlight missing check-ins, WFH, pending requests, and holidays with compact square icon collapse
// @match        https://amisapp.misa.vn/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const appMap = {};
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
            try {
                if (this.responseType !== '' && this.responseType !== 'text') return;

                const url = this.responseURL || '';

                // 1. Intercept Attendance Applications (WFH, Leave, Meetings, etc.)
                if (url.includes('/api/AttendanceEmployee/v2/datapaging') || url.includes('/api/Attendance/')) {
                    try {
                        const res = JSON.parse(this.responseText);
                        const list = res?.Data || [];
                        if (Array.isArray(list)) {
                            list.forEach(app => {
                                if (app && app.AttendanceID) {
                                    appMap[app.AttendanceID] = {
                                        id: app.AttendanceID,
                                        typeName: app.AttendanceTypeName || 'Đơn xin nghỉ / WFH',
                                        leaveDay: app.LeaveDay || 0,
                                        status: app.Status,
                                        reason: app.Reason || ''
                                    };
                                }
                            });
                        }
                    } catch (e) {}
                }

                // 2. Intercept Timesheet Monthly Grid
                if (url.includes('/api/TimeSheet/get-timesheetdatadetail')) {
                    try {
                        const data = JSON.parse(this.responseText);
                        analyzeTimesheet(data);
                    } catch (e) {
                        console.error("[Tracker] Failed to parse timesheet data:", e);
                    }
                }
            } catch (err) {}
        });

        return originalSend.apply(this, arguments);
    };

    function analyzeTimesheet(json) {
        const details = json?.Data?.DataDetail;
        if (!details || !Array.isArray(details)) return;

        const apiHolidays = json?.Data?.Holiday || [];

        // Local Vietnam Time
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        const pendingRequests = [];
        const missingPunches = [];
        const leaveDays = [];
        const incompleteDays = [];
        const publicHolidays = [];

        details.forEach(item => {
            if (!item || !item.TimeSheetDate) return;

            const dateStr = item.TimeSheetDate.split('T')[0];
            const [y, m, d] = dateStr.split('-').map(Number);
            const itemDate = new Date(y, m - 1, d);
            const dayOfWeek = itemDate.getDay();

            // Skip weekends and future dates
            if (dayOfWeek === 0 || dayOfWeek === 6 || itemDate > todayDate) return;

            const isToday = (dateStr === todayStr);
            const rawData = item.TimeSheetData ? JSON.parse(item.TimeSheetData) : [];

            if (rawData.length === 0) {
                const holidayMatch = apiHolidays.find(h => {
                    const from = h.FromDate ? h.FromDate.split('T')[0] : '';
                    const to = h.ToDate ? h.ToDate.split('T')[0] : '';
                    return dateStr >= from && dateStr <= to;
                });

                if (holidayMatch) {
                    publicHolidays.push({ date: dateStr, isToday, name: holidayMatch.HolidayTypeName || "Nghỉ Lễ/Tết" });
                    return;
                }

                missingPunches.push({ date: dateStr, isToday, note: "No check-in/out record" });
                return;
            }

            const shift = rawData[0];
            const checkIn = shift.CheckStartTime ? shift.CheckStartTime.split('T')[1].slice(0, 5) : null;
            const checkOut = shift.CheckEndTime ? shift.CheckEndTime.split('T')[1].slice(0, 5) : null;
            const actualWork = shift.TotalWorkingActual !== undefined ? shift.TotalWorkingActual : (shift.Working || 0);

            // 1. PUBLIC HOLIDAY CHECK
            let holidayName = null;
            if (shift.WorkingHoliday) {
                try {
                    const wh = JSON.parse(shift.WorkingHoliday);
                    holidayName = wh.HolidayName;
                } catch(e){}
            }
            if (!holidayName && (shift.DayType === 3 || shift.TotalLeaveHoliday > 0)) {
                const hMatch = apiHolidays.find(h => {
                    const from = h.FromDate ? h.FromDate.split('T')[0] : '';
                    const to = h.ToDate ? h.ToDate.split('T')[0] : '';
                    return dateStr >= from && dateStr <= to;
                });
                holidayName = hMatch?.HolidayTypeName || "Nghỉ Lễ/Tết";
            }

            if (holidayName || shift.DayType === 3) {
                publicHolidays.push({ date: dateStr, isToday, name: holidayName || "Nghỉ Lễ/Tết" });
                return;
            }

            let dataInfo = {};
            if (shift.DataInfo) {
                try { dataInfo = JSON.parse(shift.DataInfo); } catch(e){}
            }

            const apps = dataInfo.Applications || [];
            const pendingApps = apps.filter(a => a.Status === 1);

            // 2. APPROVED LEAVE / WFH
            const hasApprovedAttendance = !!(shift.ListAttendance || (apps.some(a => a.Status === 2)));
            let leaveAmount = hasApprovedAttendance ? (shift.TotalLeave || 0) : 0;
            let leaveName = shift.AttendanceTypeName || "Nghỉ";

            if (hasApprovedAttendance && shift.ListAttendance) {
                try {
                    const att = JSON.parse(shift.ListAttendance);
                    if (att && att[0] && att[0].AttendanceTypeName) {
                        leaveName = att[0].AttendanceTypeName;
                    }
                } catch(e) {}
            }

            // 3. PENDING REQUESTS
            if (pendingApps.length > 0) {
                const appDetails = pendingApps.map(a => {
                    const mapped = appMap[a.ApplicationID];
                    return mapped ? `${mapped.typeName} (${mapped.leaveDay} ngày)` : "Đơn chờ duyệt";
                }).join(", ");

                const punchTimes = (checkIn || checkOut) ? ` [In: ${checkIn || '--'}, Out: ${checkOut || '--'}]` : '';
                pendingRequests.push({ date: dateStr, isToday, note: `⏳ ${appDetails}${punchTimes}` });
                return;
            }

            if (leaveAmount > 0) {
                leaveDays.push({ date: dateStr, isToday, amount: leaveAmount, type: leaveName });
            }

            const totalCredit = actualWork + leaveAmount;

            // 4. MISSING PUNCHES / INCOMPLETE SHIFT
            if (totalCredit < 1.0) {
                if (!checkIn && !checkOut) {
                    missingPunches.push({ date: dateStr, isToday, note: "Missing Check-in & Check-out" });
                } else if (!checkIn) {
                    missingPunches.push({ date: dateStr, isToday, note: `Missing Check-in (Out: ${checkOut})` });
                } else if (!checkOut) {
                    if (isToday) {
                        incompleteDays.push({ date: dateStr, isToday, note: `In at ${checkIn} (Check-out pending)` });
                    } else {
                        missingPunches.push({ date: dateStr, isToday, note: `Missing Check-out (In: ${checkIn})` });
                    }
                } else {
                    incompleteDays.push({
                        date: dateStr,
                        isToday,
                        note: `Work: ${actualWork}x ${leaveAmount > 0 ? `(+${leaveAmount}x leave)` : ''} (< 1.0x total)`
                    });
                }
            }
        });

        renderWidget(pendingRequests, missingPunches, leaveDays, incompleteDays, publicHolidays);
    }

    function applyBoxStyles(el, isCollapsed) {
        el.style.cssText = `
            position: fixed;
            top: 70px;
            right: 20px;
            z-index: 999999;
            background: #ffffff;
            border: 2px solid #6153df;
            border-radius: 8px;
            box-shadow: 0 4px 18px rgba(0,0,0,0.18);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            color: #212121;
            box-sizing: border-box;
            transition: width 0.2s ease, height 0.2s ease, padding 0.2s ease;
            ${isCollapsed
                ? 'width: 40px; height: 40px; padding: 0; display: flex; align-items: center; justify-content: center; cursor: pointer;'
                : 'width: 330px; height: auto; padding: 12px 16px; display: block; cursor: default;'}
        `;
    }

    function renderWidget(pendingRequests, missingPunches, leaveDays, incompleteDays, publicHolidays) {
        let box = document.getElementById('amis-missing-checker-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'amis-missing-checker-box';
            box.setAttribute('data-collapsed', 'false');
            document.body.appendChild(box);
        }

        const isCollapsed = box.getAttribute('data-collapsed') === 'true';
        const totalAttention = pendingRequests.length + missingPunches.length;

        applyBoxStyles(box, isCollapsed);

        // 1. COLLAPSED VIEW: A compact 40x40px square icon
        let collapsedHtml = `
            <div id="amis-collapsed-view" style="display:${isCollapsed ? 'flex' : 'none'}; width:100%; height:100%; align-items:center; justify-content:center; position:relative;" title="Click to view Attendance Summary">
                <span style="font-size:20px; line-height:1; user-select:none;">📊</span>
                ${totalAttention > 0 ? `
                    <span style="position:absolute; top:-6px; right:-6px; background:#e02915; color:#fff; border-radius:10px; padding:1px 5px; font-size:10px; font-weight:bold; line-height:14px; min-width:16px; text-align:center; box-shadow:0 1px 3px rgba(0,0,0,0.3);">
                        ${totalAttention}
                    </span>` : ''}
            </div>
        `;

        // 2. EXPANDED VIEW: Full list with header & minus button
        let expandedHtml = `
            <div id="amis-expanded-view" style="display:${isCollapsed ? 'none' : 'block'};">
                <div style="display:flex; justify-content:space-between; align-items:center; font-weight:bold; font-size:14px; color:#6153df; border-bottom:1px solid #eee; padding-bottom:6px; user-select:none;">
                    <span>📊 Attendance Summary ${totalAttention > 0 ? `<span style="background:#e02915; color:#fff; border-radius:10px; padding:1px 7px; font-size:11px; margin-left:4px;">${totalAttention}</span>` : ''}</span>
                    <button id="amis-widget-collapse-btn" style="background:none; border:none; color:#6153df; font-weight:bold; font-size:18px; cursor:pointer; padding:0 4px; line-height:1;" title="Collapse to icon">−</button>
                </div>
                <div id="amis-widget-body" style="margin-top:8px;">
        `;

        // Pending Requests
        if (pendingRequests.length > 0) {
            expandedHtml += `<div style="font-weight:bold; color:#d97706; margin-top:8px;">⏳ Pending Approval (${pendingRequests.length})</div>
            <ul style="margin:4px 0 8px 0; padding-left:18px;">`;
            pendingRequests.forEach(p => {
                const todayTag = p.isToday ? ' <span style="background:#fef3c7; color:#92400e; padding:1px 4px; border-radius:3px; font-size:10px;">TODAY</span>' : '';
                expandedHtml += `<li style="margin-bottom:3px;"><b>${p.date}</b>${todayTag}: ${p.note}</li>`;
            });
            expandedHtml += `</ul>`;
        }

        // Missing Punches
        if (missingPunches.length > 0) {
            expandedHtml += `<div style="font-weight:bold; color:#e02915; margin-top:8px;">⚠️ Missing Punches (${missingPunches.length})</div>
            <ul style="margin:4px 0 8px 0; padding-left:18px;">`;
            missingPunches.forEach(p => {
                const todayTag = p.isToday ? ' <span style="background:#ffe0e0; color:#c00; padding:1px 4px; border-radius:3px; font-size:10px;">TODAY</span>' : '';
                expandedHtml += `<li style="margin-bottom:3px;"><b>${p.date}</b>${todayTag}: ${p.note}</li>`;
            });
            expandedHtml += `</ul>`;
        }

        // Days under 1.0 work credit
        if (incompleteDays.length > 0) {
            expandedHtml += `<div style="font-weight:bold; color:#2563eb; margin-top:8px;">⏱️ Today / Partial Shift (${incompleteDays.length})</div>
            <ul style="margin:4px 0 8px 0; padding-left:18px;">`;
            incompleteDays.forEach(d => {
                const todayTag = d.isToday ? ' <span style="background:#dbeafe; color:#1e40af; padding:1px 4px; border-radius:3px; font-size:10px;">TODAY</span>' : '';
                expandedHtml += `<li style="margin-bottom:3px;"><b>${d.date}</b>${todayTag}: ${d.note}</li>`;
            });
            expandedHtml += `</ul>`;
        }

        // Approved Leave / WFH
        if (leaveDays.length > 0) {
            expandedHtml += `<div style="font-weight:bold; color:#059669; margin-top:8px;">🌴 Approved Leave & WFH (${leaveDays.length})</div>
            <ul style="margin:4px 0 8px 0; padding-left:18px;">`;
            leaveDays.forEach(l => {
                const todayTag = l.isToday ? ' <span style="background:#d1fae5; color:#065f46; padding:1px 4px; border-radius:3px; font-size:10px;">TODAY</span>' : '';
                expandedHtml += `<li style="margin-bottom:3px;"><b>${l.date}</b>${todayTag}: ${l.amount} day (${l.type})</li>`;
            });
            expandedHtml += `</ul>`;
        }

        // Public Holidays
        if (publicHolidays.length > 0) {
            expandedHtml += `<div style="font-weight:bold; color:#7c3aed; margin-top:8px;">🎉 Public Holidays (${publicHolidays.length})</div>
            <ul style="margin:4px 0 8px 0; padding-left:18px;">`;
            publicHolidays.forEach(h => {
                const todayTag = h.isToday ? ' <span style="background:#ede9fe; color:#5b21b6; padding:1px 4px; border-radius:3px; font-size:10px;">TODAY</span>' : '';
                expandedHtml += `<li style="margin-bottom:3px;"><b>${h.date}</b>${todayTag}: ${h.name}</li>`;
            });
            expandedHtml += `</ul>`;
        }

        if (pendingRequests.length === 0 && missingPunches.length === 0 && incompleteDays.length === 0 && leaveDays.length === 0 && publicHolidays.length === 0) {
            expandedHtml += `<div style="color:#11aa7a; font-weight:bold;">✅ All weekdays up to today have 1.0 full work credit!</div>`;
        }

        expandedHtml += `</div></div>`;

        box.innerHTML = collapsedHtml + expandedHtml;

        // Toggle Handlers
        const colView = document.getElementById('amis-collapsed-view');
        const collapseBtn = document.getElementById('amis-widget-collapse-btn');

        if (colView) {
            colView.onclick = function() {
                box.setAttribute('data-collapsed', 'false');
                applyBoxStyles(box, false);
                colView.style.display = 'none';
                const expView = document.getElementById('amis-expanded-view');
                if (expView) expView.style.display = 'block';
            };
        }

        if (collapseBtn) {
            collapseBtn.onclick = function(e) {
                e.stopPropagation();
                box.setAttribute('data-collapsed', 'true');
                applyBoxStyles(box, true);
                const expView = document.getElementById('amis-expanded-view');
                if (expView) expView.style.display = 'none';
                if (colView) colView.style.display = 'flex';
            };
        }
    }
})();
