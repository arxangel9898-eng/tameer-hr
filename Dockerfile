FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node automation-center.mjs automation-kpi.mjs automation-queue.mjs kpi-visibility.mjs payroll-center.mjs payroll-growth.mjs payroll-control.mjs compensation-history.mjs salary-workflows.mjs turnover-kpi.mjs android-release.mjs finance-moysklad.mjs kpi-auto.mjs kpi-auto-presets.mjs kpi-auto-monthly.mjs attendance-training.mjs training-media.mjs training-catalog.mjs attendance-cabinet.mjs attendance-uz.mjs moysklad.mjs period-attendance-reports.mjs late-permission.mjs store-excellence.mjs s3-archive.mjs server.mjs attendance-tools.mjs attendance-self-month.mjs attendance-mini.mjs store-geofence.mjs shift-bot-message-sync.mjs telegram-video-retry.mjs indoor-zones.mjs shift-bot-automation.mjs telegram-history.mjs shift-excel-reports.mjs attendance-excel.mjs workspace-views.mjs daily-attendance-reports.mjs early-exit-group.mjs early-exit.mjs day-off-notifications.mjs leave-notifications.mjs store-network.mjs finance-approval.mjs shift-schedule.mjs store-ops.mjs store-sales.mjs model.mjs attendance.mjs payroll.mjs telegram.mjs telegram-attendance.mjs attendance-bot.mjs hr.mjs notifications.mjs visitors.mjs finance.mjs role-catalog.mjs accounts.mjs hr-assistant.mjs hr-development.mjs setup-telegram.mjs recruitment.mjs recruitment-web.mjs candidate-identity.mjs hr-setup.mjs hr-workflows.mjs hr-academy.mjs hr-month-close.mjs manager.mjs recruitment-questions.mjs employee-portal.mjs operations.mjs discipline.mjs hr-insights.mjs legal-news.mjs ./
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
ENV NODE_ENV=production BIND_ADDRESS=0.0.0.0 DATA_DIR=/data PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
