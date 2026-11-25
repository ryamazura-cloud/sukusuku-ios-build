const uploadLimit = 16000000;

bool validVideoDuration(double? milliseconds) =>
    milliseconds != null &&
    milliseconds.isFinite &&
    milliseconds > 0 &&
    milliseconds <= 60000;
