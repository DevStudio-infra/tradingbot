import { aiAnalysis } from "./aiAnalysis.js";
import { getHistoricalBars } from "./alpaca.js";
import { generateAnalysisChart } from "./chartAnalysis.js";
import { database } from "./database.js";
import type { BacktestResult, Trade } from "../types/trading.js";

class BacktestingService {
  private static instance: BacktestingService;

  private constructor() {}

  public static getInstance(): BacktestingService {
    if (!BacktestingService.instance) {
      BacktestingService.instance = new BacktestingService();
    }
    return BacktestingService.instance;
  }

  public async runBacktest(
    symbol: string,
    timeframe: string,
    startDate: Date,
    endDate: Date,
    initialBalance: number = 100000,
    riskPerTrade: number = 0.01
  ): Promise<BacktestResult> {
    try {
      console.log(`[Backtest] Starting backtest for ${symbol} from ${startDate.toISOString()} to ${endDate.toISOString()}`);

      // Validate dates
      if (startDate > endDate) {
        throw new Error("Start date must be before end date");
      }

      // Get historical bars
      const bars = await getHistoricalBars(symbol, timeframe, undefined, startDate, endDate);

      // Validate we have enough bars
      if (bars.length < 60) {
        throw new Error(`Insufficient historical data. Need at least 60 bars, but got ${bars.length}. This could be due to market holidays or limited market hours.`);
      }

      const positions: Trade[] = [];
      const equityCurve: { timestamp: string; balance: number }[] = [{ timestamp: bars[0].timestamp, balance: initialBalance }];
      let balance = initialBalance;
      const analysisHistory: { timestamp: string; chart_image: string; analysis_result: any }[] = [];

      // Process each bar
      for (let i = 60; i < bars.length; i++) {
        const currentBar = bars[i];

        // Update open positions
        await this.updateOpenPositions(positions, currentBar, balance);

        try {
          // Get the last 60 bars for analysis
          const analysisWindow = bars.slice(i - 60, i + 1);
          const chartImage = await generateAnalysisChart(analysisWindow, symbol);
          const analysis = await aiAnalysis.analyzeChart(symbol, timeframe, balance, positions);

          // Save analysis history
          analysisHistory.push({
            timestamp: currentBar.timestamp,
            chart_image: chartImage.toString("base64"),
            analysis_result: analysis,
          });

          // Execute trades based on analysis
          if (positions.length < 3 && analysis.recommendation.action !== "hold" && analysis.confidence >= 75) {
            const position = await this.executePosition(symbol, analysis, currentBar, balance, riskPerTrade);
            if (position) {
              positions.push(position);
              console.log(`[Backtest] New position opened: ${position.side} ${position.size} units at ${position.entry_price}`);
            }
          }
        } catch (error) {
          console.error(`[Backtest] Error analyzing bar ${currentBar.timestamp}:`, error);
        }

        // Update equity curve
        balance = this.calculateCurrentBalance(balance, positions);
        equityCurve.push({ timestamp: currentBar.timestamp, balance });
      }

      // Close any remaining positions
      this.closeAllPositions(positions, bars[bars.length - 1]);

      // Calculate final statistics
      const stats = this.calculateStatistics(positions, initialBalance, balance, equityCurve);

      const result: BacktestResult = {
        symbol,
        timeframe,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        initial_balance: Number(initialBalance),
        final_balance: Number(balance),
        total_trades: stats.total_trades,
        winning_trades: stats.winning_trades,
        losing_trades: stats.losing_trades,
        win_rate: Number(stats.win_rate),
        average_win: Number(stats.average_win),
        average_loss: Number(stats.average_loss),
        profit_factor: Number(stats.profit_factor),
        max_drawdown: Number(stats.max_drawdown),
        max_drawdown_percentage: Number(stats.max_drawdown_percentage),
        trades: positions,
        equity_curve: equityCurve,
        analysis_history: analysisHistory,
      };

      try {
        // Store results in database
        const backtest = await database.createBacktest(result);

        // Only try to add trades if there are any
        if (positions.length > 0) {
          await database.addBacktestTrades(backtest.id, result.trades);
        }

        // Add analysis and equity curve data
        await database.addBacktestAnalysis(backtest.id, result.analysis_history);
        await database.addBacktestEquityCurve(backtest.id, result.equity_curve);

        console.log(`[Backtest] Completed backtest for ${symbol}:`, {
          total_trades: positions.length,
          win_rate: stats.win_rate,
          profit_factor: stats.profit_factor,
          final_balance: balance,
          analysis_count: analysisHistory.length,
        });

        return result;
      } catch (error) {
        console.error("[Backtest] Error saving results to database:", error);
        throw new Error("Failed to save backtest results to database");
      }
    } catch (error) {
      console.error(`[Backtest] Error running backtest:`, error);
      throw error;
    }
  }

  private async updateOpenPositions(positions: Trade[], currentBar: any, balance: number): Promise<void> {
    for (const position of positions) {
      // Check stop loss
      if (position.side === "long" && currentBar.low <= position.stop_loss) {
        await this.closePosition(position, position.stop_loss, currentBar.timestamp, "stop_loss", balance);
      } else if (position.side === "short" && currentBar.high >= position.stop_loss) {
        await this.closePosition(position, position.stop_loss, currentBar.timestamp, "stop_loss", balance);
      }

      // Check take profit
      if (position.side === "long" && currentBar.high >= position.take_profit) {
        await this.closePosition(position, position.take_profit, currentBar.timestamp, "take_profit", balance);
      } else if (position.side === "short" && currentBar.low <= position.take_profit) {
        await this.closePosition(position, position.take_profit, currentBar.timestamp, "take_profit", balance);
      }
    }

    // Remove closed positions
    positions.splice(0, positions.length, ...positions.filter((p) => !p.exit_time));
  }

  private async executePosition(symbol: string, analysis: any, currentBar: any, balance: number, riskPerTrade: number): Promise<Trade | null> {
    const { action, entry_price, stop_loss, take_profit, risk_percentage } = analysis.recommendation;

    if (!entry_price || !stop_loss || !take_profit) {
      return null;
    }

    const riskAmount = balance * (risk_percentage || riskPerTrade);
    const riskPerShare = Math.abs(entry_price - stop_loss);
    const positionSize = Math.floor(riskAmount / riskPerShare);

    return {
      symbol,
      side: action === "buy" ? "long" : "short",
      entry_price,
      stop_loss,
      take_profit,
      size: positionSize,
      entry_time: currentBar.timestamp,
    };
  }

  private async closePosition(position: Trade, exitPrice: number, exitTime: string, reason: string, balance: number): Promise<void> {
    position.exit_price = exitPrice;
    position.exit_time = exitTime;
    position.reason = reason;

    // Calculate P&L
    const pnl = position.side === "long" ? (exitPrice - position.entry_price) * position.size : (position.entry_price - exitPrice) * position.size;

    position.pnl = pnl;
    position.pnl_percentage = (pnl / balance) * 100;
  }

  private calculateCurrentBalance(balance: number, positions: Trade[]): number {
    return positions.reduce((acc, pos) => acc + (pos.pnl || 0), balance);
  }

  private calculateStatistics(positions: Trade[], initialBalance: number, finalBalance: number, equityCurve: { timestamp: string; balance: number }[]): any {
    const closedPositions = positions.filter((p) => p.exit_price !== undefined);
    const winningTrades = closedPositions.filter((p) => (p.pnl || 0) > 0);
    const losingTrades = closedPositions.filter((p) => (p.pnl || 0) <= 0);

    const totalWins = winningTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
    const totalLosses = Math.abs(losingTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0));

    // Calculate max drawdown
    let maxDrawdown = 0;
    let maxDrawdownPercentage = 0;
    let peak = initialBalance;

    equityCurve.forEach((point) => {
      const balance = Number(point.balance);
      if (balance > peak) {
        peak = balance;
      }
      const drawdown = peak - balance;
      const drawdownPercentage = (drawdown / peak) * 100;

      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercentage = drawdownPercentage;
      }
    });

    return {
      total_trades: closedPositions.length,
      winning_trades: winningTrades.length,
      losing_trades: losingTrades.length,
      win_rate: winningTrades.length / (closedPositions.length || 1),
      average_win: winningTrades.length > 0 ? totalWins / winningTrades.length : 0,
      average_loss: losingTrades.length > 0 ? totalLosses / losingTrades.length : 0,
      profit_factor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
      max_drawdown: maxDrawdown,
      max_drawdown_percentage: maxDrawdownPercentage,
    };
  }

  private closeAllPositions(positions: Trade[], lastBar: any): void {
    positions.forEach((position) => {
      if (!position.exit_time) {
        this.closePosition(position, lastBar.close, lastBar.timestamp, "end_of_backtest", 0);
      }
    });
  }
}

export const backtesting = BacktestingService.getInstance();
