const { DataTypes } = require("sequelize");

module.exports = {
  up: async ({ context: queryInterface }) => {
    await queryInterface.createTable("email_notification_logs", {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING(80),
        allowNull: false,
      },
      travelPlanId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      clientTradeAlertId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      matchId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      clientId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      tradesmanId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      recipientUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      recipientEmail: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM("sent", "failed", "skipped"),
        allowNull: false,
        defaultValue: "sent",
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });

    await queryInterface.addIndex("email_notification_logs", ["type"]);
    await queryInterface.addIndex("email_notification_logs", ["travelPlanId"]);
    await queryInterface.addIndex("email_notification_logs", ["clientTradeAlertId"]);
    await queryInterface.addIndex("email_notification_logs", ["matchId"]);
    await queryInterface.addIndex("email_notification_logs", ["recipientUserId"]);
    await queryInterface.addIndex("email_notification_logs", {
      name: "uq_email_notification_logs_once",
      unique: true,
      fields: ["type", "travelPlanId", "clientTradeAlertId", "recipientUserId"],
    });
  },

  down: async ({ context: queryInterface }) => {
    await queryInterface.dropTable("email_notification_logs");
  },
};
