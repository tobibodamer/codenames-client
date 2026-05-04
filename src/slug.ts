function randomItem(arr: string[]) {
  return arr[Math.floor(Math.random() * arr.length)]
}

const consonants = [
  "b",
  "c",
  "d",
  "f",
  "g",
  "h",
  "j",
  "k",
  "l",
  "m",
  "n",
  "p",
  "r",
  "s",
  "t",
  "v",
  "z",
]
const vowels = ["a", "e", "i", "o", "u"]

function makeSyllable() {
  return randomItem(consonants) + randomItem(vowels)
}

function makeWord(syllables = 2) {
  let word = ""
  for (let i = 0; i < syllables; i++) {
    word += makeSyllable()
  }
  return word
}

export function generateRoomId() {
  return `${makeWord(2)}-${makeWord(2)}`
}

export function generateCredentials() {
  return `${makeWord(4)}-${makeWord(4)}-${makeWord(4)}`
}