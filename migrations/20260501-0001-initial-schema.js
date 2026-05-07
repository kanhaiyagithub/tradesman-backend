const { DataTypes } = require('sequelize');

/**
 * Loads existing table names once and compares them case-insensitively.
 *
 * This keeps the baseline migration safe for environments that already have
 * a live schema created by older `sequelize.sync()` boots.
 *
 * @param {import('sequelize').QueryInterface} queryInterface - Sequelize query interface.
 * @returns {Promise<Set<string>>} Lower-cased table names.
 */
const getExistingTableNames = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();

  return new Set(
    tables.map((entry) => {
      if (typeof entry === 'string') {
        return entry.toLowerCase();
      }

      return String(entry.tableName || entry.table_name || '').toLowerCase();
    })
  );
};

/**
 * Checks whether a table already exists.
 *
 * @param {Set<string>} existingTables - Lower-cased table names.
 * @param {string} tableName - Target table name.
 * @returns {boolean} True when the table already exists.
 */
const hasTable = (existingTables, tableName) =>
  existingTables.has(String(tableName).toLowerCase());

/**
 * Creates a table only when it does not already exist.
 *
 * Returns whether the table was created during this migration run.
 *
 * @param {import('sequelize').QueryInterface} queryInterface - Sequelize query interface.
 * @param {Set<string>} existingTables - Known table names.
 * @param {Set<string>} createdTables - Tables created by this migration run.
 * @param {string} tableName - Table name.
 * @param {object} schema - Column definitions.
 * @returns {Promise<boolean>} True when the table was created now.
 */
const ensureTable = async (
  queryInterface,
  existingTables,
  createdTables,
  tableName,
  schema
) => {
  const normalizedTableName = String(tableName).toLowerCase();

  if (hasTable(existingTables, tableName)) {
    console.log(`[MIGRATION] Table already exists, skipping create: ${tableName}`);
    return false;
  }

  await queryInterface.createTable(tableName, schema);
  existingTables.add(normalizedTableName);
  createdTables.add(normalizedTableName);

  console.log(`[MIGRATION] Created table: ${tableName}`);
  return true;
};

/**
 * Builds a normalized signature for an index field list.
 *
 * This lets the migration detect equivalent indexes even if legacy environments
 * use different auto-generated index names.
 *
 * @param {Array<string|object>} fields - Index field list.
 * @returns {string} Stable normalized signature.
 */
const buildFieldSignature = (fields = []) =>
  fields
    .map((field) => {
      if (typeof field === 'string') {
        return field;
      }

      return String(field.attribute || field.name || field.field || '').trim();
    })
    .filter(Boolean)
    .join('|')
    .toLowerCase();

/**
 * Adds an index only when:
 * - the table was created by this baseline migration, and
 * - an equivalent index does not already exist
 *
 * Why this behavior is important:
 * Baseline migrations should avoid aggressively backfilling indexes onto old
 * production tables, because those tables may already contain many historical
 * indexes created by previous `sync({ alter: true })` runs.
 *
 * @param {import('sequelize').QueryInterface} queryInterface - Sequelize query interface.
 * @param {Set<string>} createdTables - Tables created in this run.
 * @param {string} tableName - Target table.
 * @param {string} indexName - Stable index name.
 * @param {object} indexOptions - Index definition passed to `addIndex`.
 * @returns {Promise<void>}
 */
const ensureIndex = async (
  queryInterface,
  createdTables,
  tableName,
  indexName,
  indexOptions
) => {
  const normalizedTableName = String(tableName).toLowerCase();

  if (!createdTables.has(normalizedTableName)) {
    console.log(
      `[MIGRATION] Table existed before baseline, skipping index backfill: ${indexName}`
    );
    return;
  }

  const indexes = await queryInterface.showIndex(tableName);
  const targetFieldSignature = buildFieldSignature(indexOptions.fields);
  const targetUnique = Boolean(indexOptions.unique);

  const existsByName = indexes.some((index) => index.name === indexName);

  const existsEquivalent = indexes.some((index) => {
    const existingFieldSignature = buildFieldSignature(
      (index.fields || []).map(
        (field) => field.attribute || field.name || field.field
      )
    );
    const existingUnique = Boolean(index.unique);

    return (
      existingFieldSignature === targetFieldSignature &&
      existingUnique === targetUnique
    );
  });

  if (existsByName || existsEquivalent) {
    console.log(`[MIGRATION] Index already exists, skipping create: ${indexName}`);
    return;
  }

  await queryInterface.addIndex(tableName, {
    name: indexName,
    ...indexOptions,
  });

  console.log(`[MIGRATION] Created index: ${indexName}`);
};

/**
 * Drops a table only when it exists.
 *
 * @param {import('sequelize').QueryInterface} queryInterface - Sequelize query interface.
 * @param {string} tableName - Target table.
 * @returns {Promise<void>}
 */
const dropTableIfExists = async (queryInterface, tableName) => {
  const tables = await getExistingTableNames(queryInterface);

  if (!hasTable(tables, tableName)) {
    return;
  }

  await queryInterface.dropTable(tableName);
};

module.exports = {
  /**
   * Creates the current project schema as an explicit migration baseline.
   *
   * Important behavior:
   * - existing production/staging tables are left intact
   * - missing tables are created for new environments
   * - indexes are only created for tables created by this migration run
   *
   * @param {{ context: import('sequelize').QueryInterface }} params - Umzug migration context.
   * @returns {Promise<void>}
   */
  up: async ({ context: queryInterface }) => {
    const existingTables = await getExistingTableNames(queryInterface);
    const createdTables = new Set();

    await ensureTable(queryInterface, existingTables, createdTables, 'admins', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      name: { type: DataTypes.STRING, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: false },
      password: { type: DataTypes.STRING, allowNull: false },
      role: {
        type: DataTypes.ENUM('admin'),
        allowNull: false,
        defaultValue: 'admin',
      },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    await ensureTable(queryInterface, existingTables, createdTables, 'Users', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      name: { type: DataTypes.STRING, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: false },
      mobile: { type: DataTypes.STRING, allowNull: true },
      password: { type: DataTypes.STRING, allowNull: true },
      role: {
        type: DataTypes.ENUM('tradesman', 'client', 'admin'),
        allowNull: false,
        defaultValue: 'client',
      },
      provider: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'manual',
      },
      googleId: { type: DataTypes.STRING, allowNull: true },
      profileImage: { type: DataTypes.STRING, allowNull: true },
      resetPasswordToken: { type: DataTypes.STRING, allowNull: true },
      resetPasswordExpires: { type: DataTypes.DATE, allowNull: true },
      isVerified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'subscription_plans',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        name: { type: DataTypes.STRING, allowNull: false },
        priceMonthly: {
          type: DataTypes.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0,
        },
        stripeProductId: { type: DataTypes.STRING, allowNull: true },
        stripePriceId: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true,
        },
        maxSharedLocations: { type: DataTypes.INTEGER, allowNull: true },
        isDefault: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'user_subscriptions',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        userId: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        planId: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: 'subscription_plans', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        stripeCustomerId: { type: DataTypes.STRING, allowNull: true },
        stripeSubscriptionId: {
          type: DataTypes.STRING,
          allowNull: true,
          unique: true,
        },
        isEarlyAccess: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        hasLifetimeDiscount: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        trialEndsAt: { type: DataTypes.DATE, allowNull: true },
        status: {
          type: DataTypes.ENUM(
            'trialing',
            'active',
            'incomplete',
            'past_due',
            'canceled',
            'unpaid'
          ),
          allowNull: false,
          defaultValue: 'incomplete',
        },
        currentPeriodStart: { type: DataTypes.DATE, allowNull: true },
        currentPeriodEnd: { type: DataTypes.DATE, allowNull: true },
        cancelAtPeriodEnd: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        startDate: { type: DataTypes.DATE, allowNull: false },
        endDate: { type: DataTypes.DATE, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'trades_type',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        name: { type: DataTypes.STRING, allowNull: false },
        category: { type: DataTypes.STRING, allowNull: false },
        isActive: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'TradesmanDetails',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        userId: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        tradeType: { type: DataTypes.STRING, allowNull: true },
        tradeTypeId: { type: DataTypes.INTEGER, allowNull: false },
        businessName: { type: DataTypes.STRING, allowNull: true },
        shortBio: { type: DataTypes.TEXT, allowNull: true },
        startDate: { type: DataTypes.DATE, allowNull: true },
        endDate: { type: DataTypes.DATE, allowNull: true },
        currentLocation: { type: DataTypes.STRING, allowNull: true },
        licenseNumber: { type: DataTypes.STRING, allowNull: true },
        licenseExpiry: { type: DataTypes.DATE, allowNull: true },
        licenseDocument: { type: DataTypes.STRING, allowNull: true },
        portfolioPhotos: { type: DataTypes.JSON, allowNull: true },
        portfolioDescription: { type: DataTypes.TEXT, allowNull: true },
        isApproved: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        approvedBy: { type: DataTypes.INTEGER, allowNull: true },
        approvedAt: { type: DataTypes.DATE, allowNull: true },
        rejectionReason: { type: DataTypes.TEXT, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'travelplans',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        tradesmanId: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        currentLocation: { type: DataTypes.STRING, allowNull: true },
        latitude: { type: DataTypes.DOUBLE, allowNull: true },
        longitude: { type: DataTypes.DOUBLE, allowNull: true },
        startLocation: { type: DataTypes.STRING, allowNull: false },
        startDateTime: { type: DataTypes.DATE, allowNull: false },
        destination: { type: DataTypes.STRING, allowNull: false },
        destinationLatitude: { type: DataTypes.DOUBLE, allowNull: false },
        destinationLongitude: { type: DataTypes.DOUBLE, allowNull: false },
        destinationDateTime: { type: DataTypes.DATE, allowNull: false },
        priceRange: { type: DataTypes.STRING, allowNull: true },
        allowStops: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        stops: { type: DataTypes.JSON, allowNull: true },
        status: {
          type: DataTypes.ENUM('open', 'running', 'closed'),
          allowNull: false,
          defaultValue: 'open',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'client_trade_alerts',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        clientId: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        tradeType: { type: DataTypes.STRING, allowNull: true },
        tradeTypeId: { type: DataTypes.INTEGER, allowNull: false },
        locationName: { type: DataTypes.STRING, allowNull: false },
        latitude: { type: DataTypes.DOUBLE, allowNull: false },
        longitude: { type: DataTypes.DOUBLE, allowNull: false },
        radiusKm: {
          type: DataTypes.DOUBLE,
          allowNull: false,
          defaultValue: 15,
        },
        isActive: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        startDate: { type: DataTypes.DATE, allowNull: true },
        endDate: { type: DataTypes.DATE, allowNull: true },
        lastMatchedAt: { type: DataTypes.DATE, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'device_tokens',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        user_id: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        token: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true,
        },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'conversations',
      {
        id: {
          type: DataTypes.BIGINT,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        directKey: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true,
        },
        userOneId: { type: DataTypes.INTEGER, allowNull: false },
        userTwoId: { type: DataTypes.INTEGER, allowNull: false },
        lastMessageId: { type: DataTypes.BIGINT, allowNull: true },
        lastMessageSenderId: { type: DataTypes.INTEGER, allowNull: true },
        lastMessagePreview: { type: DataTypes.TEXT, allowNull: true },
        lastMessageAt: { type: DataTypes.DATE, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'messages',
      {
        id: {
          type: DataTypes.BIGINT,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        conversationId: {
          type: DataTypes.BIGINT,
          allowNull: true,
          references: { model: 'conversations', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        senderId: { type: DataTypes.INTEGER, allowNull: false },
        receiverId: { type: DataTypes.INTEGER, allowNull: false },
        conversationKey: { type: DataTypes.STRING, allowNull: false },
        message: { type: DataTypes.TEXT, allowNull: false },
        isRead: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'conversation_participants',
      {
        id: {
          type: DataTypes.BIGINT,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        conversationId: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: 'conversations', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        userId: { type: DataTypes.INTEGER, allowNull: false },
        otherUserId: { type: DataTypes.INTEGER, allowNull: false },
        unreadCount: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        lastReadMessageId: { type: DataTypes.BIGINT, allowNull: true },
        lastReadAt: { type: DataTypes.DATE, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(queryInterface, existingTables, createdTables, 'hires', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      clientId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      tradesmanId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      status: {
        type: DataTypes.ENUM(
          'pending',
          'accepted',
          'rejected',
          'completed',
          'cancelled'
        ),
        allowNull: false,
        defaultValue: 'pending',
      },
      jobDescription: { type: DataTypes.TEXT, allowNull: true },
      requestCompletion: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    await ensureTable(queryInterface, existingTables, createdTables, 'reviews', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      hireId: { type: DataTypes.INTEGER, allowNull: false },
      fromUserId: { type: DataTypes.INTEGER, allowNull: false },
      toUserId: { type: DataTypes.INTEGER, allowNull: false },
      rating: { type: DataTypes.INTEGER, allowNull: false },
      comment: { type: DataTypes.TEXT, allowNull: true },
      role: {
        type: DataTypes.ENUM('client', 'tradesman'),
        allowNull: false,
      },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'tradesman_live_locations',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        tradesmanId: {
          type: DataTypes.INTEGER,
          allowNull: false,
          unique: true,
        },
        travelPlanId: { type: DataTypes.INTEGER, allowNull: false },
        latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
        longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'live_proximity_notifications',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        tradesmanId: { type: DataTypes.INTEGER, allowNull: false },
        travelPlanId: { type: DataTypes.INTEGER, allowNull: false },
        clientId: { type: DataTypes.INTEGER, allowNull: false },
        clientTradeAlertId: { type: DataTypes.INTEGER, allowNull: false },
        lastNotifiedAt: { type: DataTypes.DATE, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'travel_plan_alert_matches',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        travelPlanId: { type: DataTypes.INTEGER, allowNull: false },
        tradesmanId: { type: DataTypes.INTEGER, allowNull: false },
        clientId: { type: DataTypes.INTEGER, allowNull: false },
        clientTradeAlertId: { type: DataTypes.INTEGER, allowNull: false },
        matchedStopName: { type: DataTypes.STRING, allowNull: true },
        matchedLatitude: { type: DataTypes.DOUBLE, allowNull: true },
        matchedLongitude: { type: DataTypes.DOUBLE, allowNull: true },
        matchedDistanceKm: { type: DataTypes.DOUBLE, allowNull: true },
        estimatedArrivalDate: { type: DataTypes.DATE, allowNull: true },
        notificationSent: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        notificationSentAt: { type: DataTypes.DATE, allowNull: true },
        status: {
          type: DataTypes.ENUM(
            'pending',
            'notified',
            'contacted',
            'ignored'
          ),
          allowNull: false,
          defaultValue: 'pending',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureTable(
      queryInterface,
      existingTables,
      createdTables,
      'PortfolioPhotos',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        userId: { type: DataTypes.INTEGER, allowNull: false },
        image: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'subscription_plans',
      'uq_subscription_plans_stripe_price_id',
      {
        unique: true,
        fields: ['stripePriceId'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'user_subscriptions',
      'uq_user_subscriptions_stripe_subscription_id',
      {
        unique: true,
        fields: ['stripeSubscriptionId'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'TradesmanDetails',
      'idx_tradesman_details_user_id',
      { fields: ['userId'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'TradesmanDetails',
      'idx_tradesman_details_trade_type_id',
      { fields: ['tradeTypeId'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'TradesmanDetails',
      'idx_tradesman_details_is_approved',
      { fields: ['isApproved'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'client_trade_alerts',
      'idx_client_trade_alerts_client_id',
      { fields: ['clientId'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'client_trade_alerts',
      'idx_client_trade_alerts_trade_type_id',
      { fields: ['tradeTypeId'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'client_trade_alerts',
      'idx_client_trade_alerts_is_active',
      { fields: ['isActive'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'device_tokens',
      'uq_device_tokens_token',
      {
        unique: true,
        fields: ['token'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'conversations',
      'uq_conversations_direct_key',
      {
        unique: true,
        fields: ['directKey'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'conversations',
      'idx_conversations_last_message_at',
      { fields: ['lastMessageAt'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'conversations',
      'idx_conversations_user_one',
      { fields: ['userOneId'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'conversations',
      'idx_conversations_user_two',
      { fields: ['userTwoId'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'messages',
      'idx_messages_conversation_id_created',
      { fields: ['conversationId', 'createdAt'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'messages',
      'idx_conversation_created',
      { fields: ['conversationKey', 'createdAt'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'messages',
      'idx_receiver_read',
      { fields: ['receiverId', 'isRead'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'messages',
      'idx_sender_receiver',
      { fields: ['senderId', 'receiverId'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'conversation_participants',
      'uq_conversation_user',
      {
        unique: true,
        fields: ['conversationId', 'userId'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'conversation_participants',
      'uq_user_other_user',
      {
        unique: true,
        fields: ['userId', 'otherUserId'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'conversation_participants',
      'idx_participant_user',
      { fields: ['userId'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'conversation_participants',
      'idx_participant_user_unread',
      { fields: ['userId', 'unreadCount'] }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'tradesman_live_locations',
      'uq_tradesman_live_locations_tradesman_id',
      {
        unique: true,
        fields: ['tradesmanId'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'live_proximity_notifications',
      'uniq_tp_client',
      {
        unique: true,
        fields: ['travelPlanId', 'clientId'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'travel_plan_alert_matches',
      'idx_travel_plan_alert_matches_travel_plan_id',
      {
        fields: ['travelPlanId'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'travel_plan_alert_matches',
      'idx_travel_plan_alert_matches_client_id',
      {
        fields: ['clientId'],
      }
    );

    await ensureIndex(
      queryInterface,
      createdTables,
      'travel_plan_alert_matches',
      'idx_travel_plan_alert_matches_client_trade_alert_id',
      {
        fields: ['clientTradeAlertId'],
      }
    );
  },

  /**
   * Reverts the baseline schema for non-production throwaway environments.
   *
   * This is intentionally destructive and should not be used against a real
   * environment that already contains live data.
   *
   * @param {{ context: import('sequelize').QueryInterface }} params - Umzug migration context.
   * @returns {Promise<void>}
   */
  down: async ({ context: queryInterface }) => {
    const tableNamesInDropOrder = [
      'PortfolioPhotos',
      'travel_plan_alert_matches',
      'live_proximity_notifications',
      'tradesman_live_locations',
      'reviews',
      'hires',
      'conversation_participants',
      'messages',
      'conversations',
      'device_tokens',
      'client_trade_alerts',
      'travelplans',
      'TradesmanDetails',
      'trades_type',
      'user_subscriptions',
      'subscription_plans',
      'Users',
      'admins',
    ];

    for (const tableName of tableNamesInDropOrder) {
      await dropTableIfExists(queryInterface, tableName);
    }
  },
};