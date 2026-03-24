require("../core/bootstrap/loadEnv").loadEnv();
const { query } = require('./postgresClient');
const bcrypt = require('bcryptjs');
const { logger } = require('../core/logger/logger');

const seedData = async () => {
  logger.info('Starting database seeding...');

  try {
    // Seed operators
    const adminPassword = await bcrypt.hash('admin123', 10);
    const operatorPassword = await bcrypt.hash('operator123', 10);
    const viewerPassword = await bcrypt.hash('viewer123', 10);

    await query(`
      INSERT INTO operators (username, password_hash, role, status)
      VALUES 
        ('admin', $1, 'admin', 'active'),
        ('operator', $2, 'operator', 'active'),
        ('viewer', $3, 'viewer', 'active')
      ON CONFLICT (username) DO NOTHING
    `, [adminPassword, operatorPassword, viewerPassword]);

    logger.info('Seeded operators');

    // Seed clients
    const clientData = [
      { name: 'Client A', risk_limits: { max_daily_loss: 50000, max_open_positions: 10, max_lots_per_trade: 5 } },
      { name: 'Client B', risk_limits: { max_daily_loss: 30000, max_open_positions: 5, max_lots_per_trade: 3 } },
      { name: 'Client C', risk_limits: { max_daily_loss: 75000, max_open_positions: 15, max_lots_per_trade: 10 } }
    ];

    for (const client of clientData) {
      await query(`
        INSERT INTO clients (name, risk_limits, status)
        VALUES ($1, $2, 'active')
        ON CONFLICT DO NOTHING
      `, [client.name, JSON.stringify(client.risk_limits)]);
    }

    logger.info('Seeded clients');

    // Seed strategies
    const strategyData = [
      { 
        name: 'BANKNIFTY_STRADDLE', 
        type: 'option_selling', 
        description: 'Sell ATM straddle on BANKNIFTY weekly expiry',
        file_path: 'packages/strategies/optionSelling/bankniftyStraddle.js',
        parameters: { strike_offset: 0, expiry: 'weekly', hedge_enabled: true }
      },
      { 
        name: 'NIFTY_IRONCONDOR', 
        type: 'option_selling', 
        description: 'Sell iron condor on NIFTY weekly expiry',
        file_path: 'packages/strategies/optionSelling/niftyIronCondor.js',
        parameters: { wings: 200, expiry: 'weekly', adjust_on_spread: true }
      },
      { 
        name: 'WEEKLY_STRANGLE', 
        type: 'option_selling', 
        description: 'Sell OTM strangle on weekly expiry',
        file_path: 'packages/strategies/optionSelling/weeklyStrangle.js',
        parameters: { delta_target: 0.15, expiry: 'weekly' }
      },
      { 
        name: 'BREAKOUT_STRATEGY', 
        type: 'option_buying', 
        description: 'Buy options on breakout from consolidation',
        file_path: 'packages/strategies/optionBuying/breakoutStrategy.js',
        parameters: { breakout_threshold: 0.5, atr_multiplier: 2 }
      },
      { 
        name: 'MOMENTUM_STRATEGY', 
        type: 'option_buying', 
        description: 'Intraday momentum-based trading',
        file_path: 'packages/strategies/optionBuying/momentumStrategy.js',
        parameters: { rsi_oversold: 30, rsi_overbought: 70, timeframe: '5min' }
      }
    ];

    for (const strategy of strategyData) {
      await query(`
        INSERT INTO strategies (name, type, description, file_path, parameters)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (name) DO NOTHING
      `, [strategy.name, strategy.type, strategy.description, strategy.file_path, JSON.stringify(strategy.parameters)]);
    }

    logger.info('Seeded strategies');

    // Get client and strategy IDs for instance creation
    const clients = await query('SELECT id FROM clients');
    const strategies = await query('SELECT id FROM strategies');

    // Seed strategy instances
    if (clients.rows.length > 0 && strategies.rows.length > 0) {
      const instanceData = [
        { client_id: clients.rows[0].id, strategy_id: strategies.rows[0].id, status: 'stopped' },
        { client_id: clients.rows[0].id, strategy_id: strategies.rows[1].id, status: 'stopped' },
        { client_id: clients.rows[1].id, strategy_id: strategies.rows[0].id, status: 'stopped' },
        { client_id: clients.rows[1].id, strategy_id: strategies.rows[3].id, status: 'stopped' }
      ];

      for (const instance of instanceData) {
        await query(`
          INSERT INTO strategy_instances (client_id, strategy_id, status)
          VALUES ($1, $2, $3)
          ON CONFLICT (client_id, strategy_id) DO NOTHING
        `, [instance.client_id, instance.strategy_id, instance.status]);
      }

      logger.info('Seeded strategy instances');
    }

    logger.info('Database seeding completed successfully');
    return { success: true };
  } catch (error) {
    logger.error('Seeding failed', { error: error.message });
    throw error;
  }
};

module.exports = { seedData };

if (require.main === module) {
  seedData()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
