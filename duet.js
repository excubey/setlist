// Points the button at the app. The fragment is read here and goes nowhere else.
document.getElementById('open').href = 'spintracker://duet#' + location.hash.slice(1);
