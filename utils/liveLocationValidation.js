const parseLiveCoordinates = ({ latitude, longitude }) => {
  if (
    latitude === undefined ||
    latitude === null ||
    longitude === undefined ||
    longitude === null
  ) {
    return {
      success: false,
      message: "latitude and longitude are required",
    };
  }

  const lat = Number(latitude);
  const lng = Number(longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return {
      success: false,
      message: "latitude and longitude must be valid numbers",
    };
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return {
      success: false,
      message: "latitude or longitude is outside the valid range",
    };
  }

  return {
    success: true,
    latitude: lat,
    longitude: lng,
  };
};

module.exports = {
  parseLiveCoordinates,
};
