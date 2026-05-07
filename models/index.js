const { Op } = require("sequelize");

exports.getFullUserProfile = async (req, res) => {
    try {
        const userId = req.params.id;

        // 1️⃣ USER + DETAILS + ACTIVE TRAVEL PLAN
        const user = await User.findByPk(userId, {
            include: [
                {
                    model: TradesmanDetails,
                    as: "TradesmanDetail",
                },
                {
                    model: TravelPlan,
                    as: "TravelPlans",
                    where: {
                        status: { [Op.in]: ["open", "running"] },
                        destinationDateTime: { [Op.gte]: new Date() },
                    },
                    required: false,
                },
            ],
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        // 2️⃣ JOB HISTORY
        let jobHistory = [];

        if (user.role === "tradesman") {
            const jobs = await Hire.findAll({
                where: { tradesmanId: userId },
                include: [{ model: User, as: "client", attributes: ["id", "name"] }],
                order: [["updatedAt", "DESC"]],
            });

            jobHistory = jobs.map((j) => ({
                jobId: j.id,
                withClient: j.client?.name,
                description: j.jobDescription,
                status: j.status,
                date: j.updatedAt,
            }));
        }

        if (user.role === "client") {
            const jobs = await Hire.findAll({
                where: { clientId: userId },
                include: [{ model: User, as: "tradesman", attributes: ["id", "name"] }],
                order: [["updatedAt", "DESC"]],
            });

            jobHistory = jobs.map((j) => ({
                jobId: j.id,
                withTradesman: j.tradesman?.name,
                description: j.jobDescription,
                status: j.status,
                date: j.updatedAt,
            }));
        }

        // 3️⃣ REVIEWS
        const reviews = await Review.findAll({
            where: { toUserId: userId },
            include: [{ model: User, as: "fromUser", attributes: ["name"] }],
        });

        const avgRating =
            reviews.length > 0
                ? (
                    reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
                ).toFixed(1)
                : "0.0";

        // 4️⃣ ACTIVE TRAVEL PLAN
        const activePlan = user.TravelPlans?.[0] || null;

        // 5️⃣ FINAL RESPONSE
        return res.json({
            success: true,
            message: "Full profile fetched",
            data: {
                id: user.id,
                name: user.name,
                profileImage: user.profileImage,
                role: user.role,

                rating: avgRating,
                reviewCount: reviews.length,

                tradeType: user.TradesmanDetail?.tradeType || null,
                businessName: user.TradesmanDetail?.businessName || null,

                location: activePlan
                    ? {
                        current: activePlan.currentLocation,
                        start: activePlan.startLocation,
                        destination: activePlan.destination,
                        stops: activePlan.allowStops ? activePlan.stops : [],
                    }
                    : null,

                availability: activePlan ? "Available" : "Not Available",
                priceRange: activePlan?.priceRange || null,
                startDate: activePlan?.startDate || null,
                endDate: activePlan?.endDate || null,

                jobHistory,
            },
        });
    } catch (error) {
        console.error("Profile Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message,
        });
    }
};