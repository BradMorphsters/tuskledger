/**
 * DashboardTiles — barrel re-export.
 *
 * Each tile has been extracted to its own file under components/tiles/.
 * This module re-exports every named export so existing importers
 * (Dashboard.jsx and any others) need no changes.
 */
export { FinancialPulse }       from './tiles/FinancialPulse'
export { CashFlowForecast }     from './tiles/CashFlowForecast'
export { DailySnapshot }        from './tiles/DailySnapshot'
export { HsaTracker }           from './tiles/HsaTracker'
export { DcfsaTracker }         from './tiles/DcfsaTracker'
export { LoanPayoffCountdown }  from './tiles/LoanPayoffCountdown'
export { PortfolioSnapshot }    from './tiles/PortfolioSnapshot'
export { CashBalances }         from './tiles/CashBalances'
export { AccountsOverview }     from './tiles/AccountsOverview'
export { SpendingPace }         from './tiles/SpendingPace'
