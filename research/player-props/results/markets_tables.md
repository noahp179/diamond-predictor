# Every market: backtest tables

## NBA, 2025-26 (trained on 2024-25)

Each cell is Brier / AUC; the best Brier is bold.

| line | player-games | sim | sim, calibrated | season avg | fitted trees | blend | board | top picks came in (said) |
|---|---|---|---|---|---|---|---|---|
| 10+ points | 33,373 | 0.1439 / 0.868 | 0.1428 / 0.868 | 0.1620 / 0.859 | 0.1395 / 0.879 | **0.1367** / 0.883 | calibrated | 92.4% (93.4%) top 3 a game |
| 15+ points | 33,373 | 0.1119 / 0.884 | 0.1116 / 0.883 | 0.1242 / 0.873 | 0.1133 / 0.882 | **0.1095** / 0.890 | calibrated | 80.2% (81.1%) top 3 a game |
| 20+ points | 33,373 | 0.0742 / 0.903 | 0.0741 / 0.903 | 0.0809 / 0.893 | 0.0750 / 0.898 | **0.0731** / 0.907 | calibrated | 60.2% (60.9%) top 3 a game |
| 25+ points | 33,373 | 0.0433 / 0.921 | 0.0434 / 0.921 | 0.0475 / 0.913 | 0.0440 / 0.914 | **0.0429** / 0.924 | raw | 37.9% (40.5%) top 3 a game |
| 30+ points | 33,373 | 0.0232 / 0.932 | 0.0231 / 0.931 | 0.0264 / 0.928 | 0.0238 / 0.927 | **0.0229** / 0.936 | calibrated | 20.1% (20.0%) top 3 a game |
| 4+ rebounds | 33,373 | 0.1690 / 0.826 | 0.1644 / 0.826 | 0.1689 / 0.821 | 0.1574 / 0.845 | **0.1558** / 0.848 | calibrated | 89.1% (89.4%) top 3 a game |
| 6+ rebounds | 33,373 | 0.1266 / 0.839 | 0.1239 / 0.839 | 0.1264 / 0.840 | 0.1222 / 0.854 | **0.1199** / 0.859 | calibrated | 72.5% (73.8%) top 3 a game |
| 8+ rebounds | 33,373 | 0.0788 / 0.866 | 0.0763 / 0.866 | 0.0780 / 0.867 | 0.0764 / 0.876 | **0.0747** / 0.884 | calibrated | 52.1% (54.1%) top 3 a game |
| 10+ rebounds | 33,373 | 0.0453 / 0.890 | 0.0433 / 0.889 | 0.0444 / 0.889 | 0.0434 / 0.899 | **0.0425** / 0.905 | calibrated | 32.9% (35.8%) top 3 a game |
| 12+ rebounds | 33,373 | 0.0238 / 0.921 | 0.0224 / 0.921 | 0.0234 / 0.920 | 0.0232 / 0.921 | **0.0223** / 0.932 | calibrated | 18.8% (20.8%) top 3 a game |
| 2+ assists | 33,373 | 0.1656 / 0.839 | 0.1610 / 0.839 | 0.1677 / 0.829 | 0.1546 / 0.855 | **0.1535** / 0.857 | calibrated | 93.5% (94.1%) top 3 a game |
| 4+ assists | 33,373 | 0.1091 / 0.875 | 0.1085 / 0.874 | 0.1107 / 0.870 | 0.1058 / 0.883 | **0.1050** / 0.887 | calibrated | 76.2% (75.5%) top 3 a game |
| 6+ assists | 33,373 | 0.0610 / 0.909 | 0.0609 / 0.908 | 0.0619 / 0.903 | 0.0613 / 0.909 | **0.0599** / 0.915 | calibrated | 50.3% (48.9%) top 3 a game |
| 8+ assists | 33,373 | 0.0318 / 0.927 | 0.0319 / 0.927 | 0.0319 / 0.924 | 0.0326 / 0.924 | **0.0317** / 0.933 | raw | 27.6% (26.6%) top 3 a game |
| 10+ assists | 33,373 | **0.0150** / 0.926 | 0.0151 / 0.926 | 0.0153 / 0.933 | 0.0157 / 0.906 | 0.0150 / 0.934 | raw | 12.9% (11.3%) top 3 a game |
| 1+ three | 33,373 | 0.1796 / 0.819 | 0.1726 / 0.819 | 0.1750 / 0.821 | **0.1604** / 0.844 | 0.1607 / 0.844 | calibrated | 88.2% (89.1%) top 3 a game |
| 2+ threes | 33,373 | 0.1503 / 0.816 | 0.1500 / 0.816 | 0.1505 / 0.817 | 0.1470 / 0.829 | **0.1457** / 0.831 | calibrated | 67.3% (69.1%) top 3 a game |
| 3+ threes | 33,373 | 0.1029 / 0.822 | 0.1030 / 0.822 | 0.1022 / 0.825 | 0.1022 / 0.830 | **0.1010** / 0.835 | raw | 45.5% (48.0%) top 3 a game |
| 4+ threes | 33,373 | 0.0589 / 0.839 | 0.0588 / 0.838 | 0.0584 / 0.841 | 0.0596 / 0.839 | **0.0584** / 0.848 | calibrated | 27.3% (28.3%) top 3 a game |
| 5+ threes | 33,373 | 0.0294 / 0.848 | 0.0293 / 0.848 | 0.0294 / 0.853 | 0.0299 / 0.838 | **0.0293** / 0.854 | calibrated | 13.9% (14.7%) top 3 a game |
| 20+ points + rebounds + assists | 33,373 | 0.1244 / 0.887 | 0.1231 / 0.886 | 0.1444 / 0.874 | 0.1228 / 0.892 | **0.1190** / 0.897 | calibrated | 88.9% (90.7%) top 3 a game |
| 25+ points + rebounds + assists | 33,373 | 0.0982 / 0.899 | 0.0976 / 0.899 | 0.1113 / 0.888 | 0.0985 / 0.897 | **0.0950** / 0.906 | calibrated | 78.0% (80.3%) top 3 a game |
| 30+ points + rebounds + assists | 33,373 | 0.0696 / 0.915 | 0.0693 / 0.915 | 0.0788 / 0.906 | 0.0703 / 0.913 | **0.0679** / 0.921 | calibrated | 62.6% (64.3%) top 3 a game |
| 35+ points + rebounds + assists | 33,373 | 0.0467 / 0.928 | 0.0467 / 0.928 | 0.0538 / 0.917 | 0.0480 / 0.921 | **0.0461** / 0.931 | calibrated | 44.2% (46.1%) top 3 a game |
| 40+ points + rebounds + assists | 33,373 | 0.0294 / 0.937 | **0.0294** / 0.937 | 0.0353 / 0.930 | 0.0310 / 0.920 | 0.0294 / 0.937 | calibrated | 28.3% (28.7%) top 3 a game |
| 15+ points + rebounds | 33,373 | 0.1398 / 0.873 | 0.1380 / 0.873 | 0.1600 / 0.862 | 0.1371 / 0.880 | **0.1330** / 0.886 | calibrated | 90.9% (92.4%) top 3 a game |
| 20+ points + rebounds | 33,373 | 0.1144 / 0.882 | 0.1136 / 0.882 | 0.1273 / 0.872 | 0.1144 / 0.885 | **0.1106** / 0.891 | calibrated | 79.7% (82.5%) top 3 a game |
| 25+ points + rebounds | 33,373 | 0.0796 / 0.901 | 0.0794 / 0.901 | 0.0876 / 0.892 | 0.0804 / 0.897 | **0.0777** / 0.907 | calibrated | 63.8% (65.8%) top 3 a game |
| 30+ points + rebounds | 33,373 | 0.0517 / 0.917 | 0.0515 / 0.916 | 0.0574 / 0.907 | 0.0525 / 0.910 | **0.0507** / 0.920 | calibrated | 44.5% (45.6%) top 3 a game |
| 35+ points + rebounds | 33,373 | 0.0310 / 0.926 | 0.0308 / 0.925 | 0.0353 / 0.919 | 0.0315 / 0.913 | **0.0305** / 0.927 | calibrated | 26.1% (27.0%) top 3 a game |
| 15+ points + assists | 33,373 | 0.1246 / 0.887 | 0.1236 / 0.887 | 0.1422 / 0.876 | 0.1240 / 0.891 | **0.1201** / 0.897 | calibrated | 90.1% (90.3%) top 3 a game |
| 20+ points + assists | 33,373 | 0.0940 / 0.903 | 0.0936 / 0.902 | 0.1055 / 0.891 | 0.0943 / 0.901 | **0.0915** / 0.908 | calibrated | 77.7% (78.5%) top 3 a game |
| 25+ points + assists | 33,373 | 0.0627 / 0.922 | 0.0627 / 0.922 | 0.0706 / 0.913 | 0.0638 / 0.919 | **0.0616** / 0.927 | raw | 60.0% (60.2%) top 3 a game |
| 30+ points + assists | 33,373 | 0.0392 / 0.934 | 0.0393 / 0.933 | 0.0447 / 0.927 | 0.0399 / 0.931 | **0.0387** / 0.938 | raw | 39.3% (40.2%) top 3 a game |
| 35+ points + assists | 33,373 | **0.0225** / 0.949 | 0.0227 / 0.948 | 0.0269 / 0.944 | 0.0238 / 0.939 | 0.0226 / 0.950 | raw | 23.2% (23.7%) top 3 a game |
| 5+ rebounds + assists | 33,373 | 0.1603 / 0.855 | 0.1540 / 0.855 | 0.1656 / 0.844 | 0.1467 / 0.871 | **0.1439** / 0.875 | calibrated | 95.5% (95.8%) top 3 a game |
| 8+ rebounds + assists | 33,373 | 0.1401 / 0.854 | 0.1378 / 0.854 | 0.1456 / 0.845 | 0.1353 / 0.864 | **0.1327** / 0.869 | calibrated | 83.1% (83.8%) top 3 a game |
| 10+ rebounds + assists | 33,373 | 0.1111 / 0.862 | 0.1093 / 0.862 | 0.1135 / 0.854 | 0.1096 / 0.865 | **0.1068** / 0.873 | calibrated | 68.3% (69.4%) top 3 a game |
| 12+ rebounds + assists | 33,373 | 0.0794 / 0.875 | 0.0780 / 0.875 | 0.0801 / 0.868 | 0.0778 / 0.878 | **0.0763** / 0.885 | calibrated | 51.6% (54.4%) top 3 a game |
| 15+ rebounds + assists | 33,373 | 0.0392 / 0.901 | 0.0386 / 0.901 | 0.0408 / 0.896 | 0.0389 / 0.899 | **0.0381** / 0.908 | calibrated | 29.8% (31.2%) top 3 a game |
| Double-double | 33,373 | 0.0456 / 0.884 | 0.0448 / 0.884 | — | 0.0452 / 0.885 | **0.0441** / 0.893 | calibrated | 31.2% (34.8%) top 3 a game |
| Triple-double | 33,373 | **0.0035** / 0.921 | 0.0035 / 0.921 | — | 0.0039 / 0.938 | 0.0036 / 0.949 | raw | 3.1% (2.4%) top 3 a game |
| 1+ steal | 33,373 | 0.2105 / 0.733 | 0.2043 / 0.733 | 0.2114 / 0.717 | 0.2016 / 0.742 | **0.1996** / 0.747 | calibrated | 71.4% (71.3%) top 3 a game |
| 2+ steals | 33,373 | 0.1262 / 0.733 | 0.1255 / 0.732 | 0.1264 / 0.722 | 0.1253 / 0.736 | **0.1243** / 0.743 | calibrated | 37.4% (38.7%) top 3 a game |
| 1+ block | 33,373 | 0.1683 / 0.744 | 0.1629 / 0.744 | 0.1643 / 0.745 | 0.1614 / 0.760 | **0.1598** / 0.765 | calibrated | 61.9% (62.4%) top 3 a game |
| 2+ blocks | 33,373 | 0.0650 / 0.796 | 0.0647 / 0.795 | 0.0643 / 0.811 | 0.0652 / 0.814 | **0.0641** / 0.822 | calibrated | 30.2% (30.6%) top 3 a game |
| 1+ steal or block | 33,373 | 0.2123 / 0.762 | 0.1969 / 0.761 | 0.2072 / 0.748 | 0.1919 / 0.775 | **0.1896** / 0.779 | calibrated | 83.4% (84.5%) top 3 a game |
| 2+ steals + blocks | 33,373 | 0.1746 / 0.750 | 0.1720 / 0.750 | 0.1735 / 0.745 | 0.1712 / 0.758 | **0.1690** / 0.764 | calibrated | 59.2% (60.8%) top 3 a game |
| 3+ steals + blocks | 33,373 | 0.1039 / 0.760 | 0.1035 / 0.759 | 0.1034 / 0.760 | 0.1038 / 0.767 | **0.1024** / 0.774 | calibrated | 36.2% (36.7%) top 3 a game |

- Calibrated simulator vs season avg: better on 39, worse on 3, too close to call on 5 (paired bootstrap over games, 95%).
- Calibrated simulator vs fitted trees: better on 19, worse on 13, too close to call on 17 (paired bootstrap over games, 95%).
- Calibrated simulator vs blend: better on 0, worse on 41, too close to call on 8 (paired bootstrap over games, 95%).

## NHL, 2025-26 (trained on 2024-25)

Each cell is Brier / AUC; the best Brier is bold.

| line | player-games | sim | sim, calibrated | season avg | fitted trees | blend | board | top picks came in (said) |
|---|---|---|---|---|---|---|---|---|
| 1+ point | 50,181 | 0.2041 / 0.687 | 0.2041 / 0.687 | 0.2054 / 0.684 | 0.2041 / 0.687 | **0.2028** / 0.692 | raw | 64.0% (63.3%) top 3 a game |
| 2+ points | 50,181 | 0.0750 / 0.753 | 0.0751 / 0.753 | 0.0750 / 0.751 | 0.0752 / 0.752 | **0.0747** / 0.758 | raw | 27.7% (26.3%) top 3 a game |
| 3+ points | 50,181 | 0.0185 / 0.810 | 0.0185 / 0.809 | 0.0185 / 0.809 | 0.0187 / 0.796 | **0.0185** / 0.812 | raw | 8.4% (7.7%) top 3 a game |
| Anytime goal | 50,181 | 0.1201 / 0.701 | 0.1201 / 0.700 | 0.1215 / 0.688 | 0.1201 / 0.701 | **0.1197** / 0.705 | calibrated | 34.6% (34.0%) top 3 a game |
| 2+ goals | 50,181 | 0.0165 / 0.788 | **0.0165** / 0.787 | 0.0166 / 0.775 | 0.0166 / 0.776 | 0.0165 / 0.787 | calibrated | 6.5% (5.6%) top 3 a game |
| 1+ assist | 50,181 | 0.1709 / 0.666 | 0.1709 / 0.666 | 0.1720 / 0.660 | 0.1703 / 0.671 | **0.1698** / 0.674 | raw | 46.7% (45.8%) top 3 a game |
| 2+ assists | 50,181 | 0.0383 / 0.742 | 0.0383 / 0.741 | 0.0384 / 0.738 | 0.0384 / 0.744 | **0.0382** / 0.751 | raw | 13.5% (12.5%) top 3 a game |
| 2+ shots on goal | 50,181 | 0.2117 / 0.713 | 0.2111 / 0.713 | 0.2115 / 0.713 | 0.2105 / 0.715 | **0.2096** / 0.718 | calibrated | 76.9% (75.4%) top 3 a game |
| 3+ shots on goal | 50,181 | 0.1471 / 0.746 | 0.1467 / 0.745 | 0.1469 / 0.745 | 0.1470 / 0.746 | **0.1459** / 0.750 | calibrated | 55.2% (52.7%) top 3 a game |
| 4+ shots on goal | 50,181 | 0.0815 / 0.779 | 0.0812 / 0.778 | 0.0813 / 0.779 | 0.0819 / 0.777 | **0.0811** / 0.783 | calibrated | 34.7% (31.8%) top 3 a game |
| 5+ shots on goal | 50,181 | 0.0398 / 0.811 | 0.0397 / 0.810 | **0.0397** / 0.813 | 0.0401 / 0.806 | 0.0397 / 0.815 | calibrated | 19.2% (17.6%) top 3 a game |
| 20+ saves | 2,788 | 0.1763 / 0.654 | **0.1761** / 0.648 | 0.1840 / 0.594 | — | — | calibrated | 81.4% (80.5%) top pick a game |
| 25+ saves | 2,788 | **0.2334** / 0.650 | 0.2357 / 0.644 | 0.2505 / 0.567 | — | — | raw | 55.3% (60.7%) top pick a game |
| 30+ saves | 2,788 | **0.1643** / 0.660 | 0.1661 / 0.656 | 0.1747 / 0.569 | — | — | raw | 28.6% (28.6%) top pick a game |

- Calibrated simulator vs season avg: better on 7, worse on 0, too close to call on 7 (paired bootstrap over games, 95%).
- Calibrated simulator vs fitted trees: better on 4, worse on 2, too close to call on 5 (paired bootstrap over games, 95%).
- Calibrated simulator vs blend: better on 0, worse on 8, too close to call on 3 (paired bootstrap over games, 95%).

## NFL, 2025 and 2026 to date (calibration cross-fitted by date)

Each cell is Brier / AUC; the best Brier is bold.

| line | player-games | sim | sim, calibrated | season avg | board | top picks came in (said) |
|---|---|---|---|---|---|---|
| 3+ catches | 4,810 | 0.2040 / 0.761 | **0.1988** / 0.757 | 0.2019 / 0.753 | calibrated | 77.1% (78.4%) top 3 a game |
| 4+ catches | 4,810 | 0.1770 / 0.777 | 0.1707 / 0.772 | **0.1707** / 0.775 | calibrated | 60.0% (61.8%) top 3 a game |
| 5+ catches | 4,810 | 0.1407 / 0.785 | 0.1340 / 0.779 | **0.1333** / 0.785 | calibrated | 45.7% (46.4%) top 3 a game |
| 6+ catches | 4,810 | 0.0989 / 0.806 | 0.0930 / 0.801 | **0.0922** / 0.809 | calibrated | 31.1% (32.0%) top 3 a game |
| 7+ catches | 4,810 | 0.0630 / 0.829 | 0.0595 / 0.821 | **0.0586** / 0.834 | calibrated | 20.4% (21.4%) top 3 a game |
| 25+ receiving yards | 4,656 | 0.2017 / 0.758 | **0.2005** / 0.755 | 0.2116 / 0.749 | calibrated | 79.6% (79.2%) top 3 a game |
| 40+ receiving yards | 4,656 | 0.1763 / 0.769 | **0.1740** / 0.764 | 0.1786 / 0.762 | calibrated | 61.6% (61.2%) top 3 a game |
| 50+ receiving yards | 4,656 | 0.1485 / 0.775 | **0.1459** / 0.770 | 0.1477 / 0.767 | calibrated | 48.4% (48.7%) top 3 a game |
| 60+ receiving yards | 4,656 | 0.1223 / 0.784 | **0.1197** / 0.778 | 0.1199 / 0.781 | calibrated | 38.5% (39.1%) top 3 a game |
| 75+ receiving yards | 4,656 | 0.0837 / 0.804 | **0.0829** / 0.798 | 0.0830 / 0.804 | calibrated | 27.7% (28.2%) top 3 a game |
| 80+ receiving yards | 4,656 | 0.0739 / 0.809 | **0.0726** / 0.802 | 0.0733 / 0.806 | calibrated | 24.1% (24.6%) top 3 a game |
| 100+ receiving yards | 4,656 | 0.0389 / 0.839 | **0.0388** / 0.829 | 0.0402 / 0.844 | calibrated | 13.5% (13.8%) top 3 a game |
| 25+ rushing yards | 2,093 | 0.1837 / 0.811 | **0.1781** / 0.803 | 0.1933 / 0.799 | calibrated | 74.8% (74.9%) top 3 a game |
| 40+ rushing yards | 2,093 | 0.1713 / 0.813 | **0.1671** / 0.808 | 0.1816 / 0.799 | calibrated | 57.1% (57.4%) top 3 a game |
| 50+ rushing yards | 2,093 | 0.1554 / 0.811 | **0.1518** / 0.803 | 0.1600 / 0.800 | calibrated | 45.6% (45.7%) top 3 a game |
| 60+ rushing yards | 2,093 | 0.1295 / 0.825 | **0.1260** / 0.818 | 0.1334 / 0.808 | calibrated | 35.8% (35.8%) top 3 a game |
| 75+ rushing yards | 2,093 | 0.0925 / 0.839 | **0.0897** / 0.826 | 0.0928 / 0.822 | calibrated | 22.4% (22.4%) top 3 a game |
| 80+ rushing yards | 2,093 | 0.0828 / 0.850 | **0.0808** / 0.834 | 0.0835 / 0.828 | calibrated | 20.1% (20.0%) top 3 a game |
| 100+ rushing yards | 2,093 | 0.0533 / 0.839 | **0.0504** / 0.821 | 0.0532 / 0.814 | calibrated | 10.6% (10.9%) top 3 a game |
| 10+ carries | 1,485 | 0.1538 / 0.862 | **0.1510** / 0.854 | 0.1679 / 0.839 | calibrated | 62.9% (63.3%) top 3 a game |
| 12+ carries | 1,485 | 0.1535 / 0.854 | **0.1506** / 0.845 | 0.1686 / 0.829 | calibrated | 52.5% (52.4%) top 3 a game |
| 15+ carries | 1,485 | 0.1442 / 0.839 | **0.1394** / 0.828 | 0.1463 / 0.814 | calibrated | 34.4% (34.4%) top 3 a game |
| 18+ carries | 1,485 | 0.1155 / 0.819 | **0.1102** / 0.803 | 0.1116 / 0.790 | calibrated | 20.7% (20.7%) top 3 a game |
| 50+ rushing + receiving yards | 4,535 | 0.1893 / 0.762 | **0.1852** / 0.757 | 0.1932 / 0.752 | calibrated | 71.6% (71.1%) top 3 a game |
| 60+ rushing + receiving yards | 4,535 | 0.1672 / 0.772 | **0.1637** / 0.768 | 0.1710 / 0.763 | calibrated | 63.9% (62.2%) top 3 a game |
| 75+ rushing + receiving yards | 4,535 | 0.1311 / 0.788 | **0.1289** / 0.781 | 0.1322 / 0.783 | calibrated | 48.4% (47.7%) top 3 a game |
| 90+ rushing + receiving yards | 4,535 | 0.0996 / 0.803 | **0.0983** / 0.794 | 0.1003 / 0.792 | calibrated | 35.3% (35.3%) top 3 a game |
| 100+ rushing + receiving yards | 4,535 | 0.0789 / 0.809 | **0.0774** / 0.800 | 0.0794 / 0.796 | calibrated | 26.9% (27.4%) top 3 a game |
| 125+ rushing + receiving yards | 4,535 | 0.0421 / 0.839 | **0.0410** / 0.829 | 0.0430 / 0.828 | calibrated | 14.3% (14.7%) top 3 a game |
| 200+ passing yards | 728 | **0.2345** / 0.597 | 0.2364 / 0.558 | 0.2633 / 0.612 | raw | 65.1% (67.8%) top pick a game |
| 225+ passing yards | 728 | **0.2397** / 0.627 | 0.2412 / 0.606 | 0.2534 / 0.621 | raw | 53.3% (51.3%) top pick a game |
| 250+ passing yards | 728 | **0.2223** / 0.649 | 0.2237 / 0.627 | 0.2250 / 0.641 | raw | 44.0% (35.1%) top pick a game |
| 275+ passing yards | 728 | **0.1748** / 0.656 | 0.1755 / 0.634 | 0.1757 / 0.633 | raw | 29.7% (21.8%) top pick a game |
| 300+ passing yards | 728 | **0.1129** / 0.679 | 0.1153 / 0.650 | 0.1208 / 0.651 | raw | 17.9% (12.2%) top pick a game |
| 1+ TD pass | 728 | **0.1674** / 0.596 | 0.1691 / 0.558 | 0.1966 / 0.574 | raw | 82.4% (88.6%) top pick a game |
| 2+ touchdown passes | 728 | 0.2453 / 0.624 | **0.2406** / 0.602 | 0.2539 / 0.585 | calibrated | 48.9% (52.1%) top pick a game |
| 3+ touchdown passes | 728 | 0.1548 / 0.627 | **0.1539** / 0.589 | 0.1555 / 0.604 | calibrated | 23.1% (24.4%) top pick a game |
| 18+ completions | 728 | 0.2175 / 0.635 | **0.2161** / 0.609 | 0.2436 / 0.628 | calibrated | 71.4% (73.5%) top pick a game |
| 20+ completions | 728 | 0.2467 / 0.621 | **0.2454** / 0.586 | 0.2537 / 0.623 | calibrated | 58.8% (58.5%) top pick a game |
| 22+ completions | 728 | **0.2326** / 0.624 | 0.2357 / 0.605 | 0.2336 / 0.638 | raw | 47.3% (50.5%) top pick a game |
| 25+ completions | 728 | **0.1664** / 0.650 | 0.1703 / 0.615 | 0.1712 / 0.635 | raw | 26.4% (26.9%) top pick a game |

- Calibrated simulator vs season avg: better on 22, worse on 0, too close to call on 19 (paired bootstrap over games, 95%).

### Against the shipped logistic prop models (same player-games)

| line | player-games | logistic model | simulator (board) | difference [95%] | top picks: model / sim |
|---|---|---|---|---|---|
| 3+ catches | 3,875 | 0.2025 / 0.754 | 0.2023 / 0.750 | -0.0003 [-0.0039, +0.0030] too close to call | 76.9% / 77.0% |
| 5+ catches | 3,875 | 0.1453 / 0.773 | 0.1463 / 0.766 | +0.0009 [-0.0025, +0.0042] too close to call | 46.0% / 45.8% |
| 7+ catches | 3,875 | 0.0659 / 0.827 | 0.0660 / 0.819 | +0.0001 [-0.0020, +0.0020] too close to call | 21.6% / 20.6% |
| 40+ receiving yards | 3,727 | 0.1809 / 0.767 | 0.1822 / 0.760 | +0.0012 [-0.0018, +0.0041] too close to call | 61.5% / 61.4% |
| 60+ receiving yards | 3,727 | 0.1300 / 0.781 | 0.1302 / 0.772 | +0.0002 [-0.0023, +0.0026] too close to call | 39.7% / 38.9% |
| 80+ receiving yards | 3,727 | 0.0826 / 0.798 | 0.0819 / 0.794 | -0.0007 [-0.0026, +0.0012] too close to call | 24.3% / 24.5% |
| 40+ rushing yards | 1,750 | 0.1794 / 0.795 | 0.1734 / 0.803 | -0.0060 [-0.0128, +0.0009] too close to call | 55.9% / 56.1% |
| 60+ rushing yards | 1,750 | 0.1439 / 0.795 | 0.1363 / 0.809 | -0.0076 [-0.0132, -0.0019] simulator better | 34.9% / 35.3% |
| 80+ rushing yards | 1,750 | 0.0981 / 0.811 | 0.0894 / 0.830 | -0.0086 [-0.0128, -0.0047] simulator better | 19.9% / 20.0% |
| 60+ rushing + receiving yards | 3,848 | 0.1716 / 0.767 | 0.1695 / 0.768 | -0.0022 [-0.0056, +0.0008] too close to call | 61.3% / 63.8% |
| 90+ rushing + receiving yards | 3,848 | 0.1085 / 0.788 | 0.1067 / 0.791 | -0.0018 [-0.0043, +0.0007] too close to call | 34.3% / 35.1% |
| 225+ passing yards | 612 | 0.2309 / 0.655 | 0.2420 / 0.626 | +0.0112 [-0.0007, +0.0234] too close to call | 55.6% / 54.2% |
| 275+ passing yards | 612 | 0.1769 / 0.656 | 0.1815 / 0.652 | +0.0046 [-0.0049, +0.0147] too close to call | 29.1% / 29.7% |
| 2+ touchdown passes | 612 | 0.2416 / 0.609 | 0.2422 / 0.598 | +0.0006 [-0.0081, +0.0090] too close to call | 49.9% / 50.4% |
