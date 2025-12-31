
const reply = "Here is the printed cake box you asked for. [MEDIA:https://support.sachetanpackaging.in/uploads/cakebox.jpg]";
let answer = reply;
let mediaUrl = null;

// Check for [MEDIA:URL] tag
const mediaMatch = answer.match(/\[MEDIA:(.*?)\]/);
if (mediaMatch) {
  mediaUrl = mediaMatch[1];
  answer = answer.replace(mediaMatch[0], "").trim();
}

console.log("Original:", reply);
console.log("Cleaned Answer:", answer);
console.log("Media URL:", mediaUrl);

const reply2 = "Here is a response without media.";
let answer2 = reply2;
let mediaUrl2 = null;
const mediaMatch2 = answer2.match(/\[MEDIA:(.*?)\]/);
if (mediaMatch2) {
    mediaUrl2 = mediaMatch2[1];
    answer2 = answer2.replace(mediaMatch2[0], "").trim();
}
console.log("Original 2:", reply2);
console.log("Cleaned Answer 2:", answer2);
console.log("Media URL 2:", mediaUrl2);
